-- 20260930708000: an agent sees and drives a company machine's desktop in one tool call, machine_screen (Jonas, 10
-- November 2026: agents ask for a desktop computer and must see and drive it; the 10 November audit measured 20 to 30
-- seconds and three tool calls per look-act-look step with machine_run, `desktop ... --shot` and company_read).
--
-- machine_screen {machine, action?, settleMs?, look?, intent?, operationKey?} optionally performs one desktop action
-- (click, double, move, drag, type, key, scroll or open), waits, takes a screenshot and returns it to the model as an
-- image in the same tool result; nothing is written to the company folder. The coding executor of the machine's node
-- runs a fixed helper shipped in the machine image (/opt/qorpera-machine/cloud-machine-screen.mjs) as root on the boot
-- named here, with the request on its stdin. A look (no action) carries no receipt and is not reviewed; an action is
-- one receipted call (receipt key machine_screen:<operationKey>) and is reviewed by its verb.
-- * qorpera_valid_machine_screen_call: an action's arguments as the machine tools record them: the call's key, the
--   machine's name, one action of a closed shape per verb (positions in screen pixels), the settle time, whether to
--   look, and the intent (required for the verbs that are reviewed). Granted to no role.
-- * qorpera_authorize_machine_screen, the coding executor's read (service_role): the run's live tool authority in a
--   company conversation (the run's own check, which refuses every tool of a paused company's run); for an action, the
--   call's own executing receipt of exactly this envelope and a run whose wake may still work; the machine of the run's
--   company and environment,
--   running on its placement with a known boot (else MACHINE_NOT_RUNNING). A worker's run may use it, as machine_run.
--   It answers where the machine runs and, for an action, the action as the receipt holds it. It writes one thing: the
--   machine's last use, at most every 30 seconds, since the idle rule counts only an agent's use (20260930055000) and
--   a desktop driven only by machine_screen would otherwise sleep after its quiet window.
-- * machine_screen joins the operations a run's observations may name.
-- Every new or patched body names this migration (20260930708000), for the deploy guards.

do $$ begin
	if to_regprocedure('public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)') is not null then
		raise exception '20260930708000 is already applied'; end if;
	if to_regprocedure('public.qorpera_authorize_machine_coding_value(jsonb,jsonb,uuid,text)') is null
		or to_regprocedure('public.qorpera_authorize_machine_command(jsonb,jsonb,text,uuid,text,jsonb)') is null then
		raise exception '20260930708000 needs company machines and save_coding_value (20260930705000)'; end if;
end $$;

set local lock_timeout = '3s';

-- Several (old, new) pairs, applied in order: each old text occurs exactly once in the definition as the earlier pairs
-- left it, and the definition does not name this migration yet. The result, not executed here.
create function pg_temp.machine_screen_patched(p_function regprocedure, p_pairs text[]) returns text
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_function); v_index integer;
begin
	if position('20260930708000' in v_definition) > 0 then
		raise exception '20260930708000 is already in %', p_function; end if;
	if coalesce(cardinality(p_pairs), 0) = 0 or cardinality(p_pairs) % 2 <> 0 or array_position(p_pairs, null) is not null then
		raise exception '20260930708000 pairs differ in %', p_function; end if;
	for v_index in 1 .. cardinality(p_pairs) by 2 loop
		if p_pairs[v_index] = '' or (length(v_definition) - length(replace(v_definition, p_pairs[v_index], '')))
			/ length(p_pairs[v_index]) <> 1 then
			raise exception '20260930708000 anchor differs in %: %', p_function, left(p_pairs[v_index], 80); end if;
		v_definition := replace(v_definition, p_pairs[v_index], p_pairs[v_index + 1]);
	end loop;
	return v_definition;
end $$;

-- 1. An action's arguments --------------------------------------------------------------------------------------------------

-- machine_screen's arguments when it acts, as the machine tools record them (cloud-machine-tools.ts checks the same):
-- operationKey, machine and action; settleMs 0 to 5000; look; intent of 1 to 200 characters of trimmed text, required
-- for click, double, drag, type, key and open. The action is one of
--   {type: click, x, y, button?: left|middle|right}, {type: double|move, x, y}, {type: drag, x, y, toX, toY},
--   {type: type, text: 1 to 500 characters, no control character but a line break or a tab},
--   {type: key, keys: 1 to 16 key names such as Return or ctrl+l},
--   {type: scroll, direction: up|down, steps?: 1 to 30, x? and y? together},
--   {type: open, target: an http(s) or file URL in printable ASCII, or an absolute path, at most 2000 characters};
-- x and toX are whole numbers 0 to 3839, y and toY 0 to 2159: pixels of the screen. Each check runs only after the ones
-- it needs (no null passes). It reads no table; STABLE as the other call checks.
create function public.qorpera_valid_machine_screen_call(p_args jsonb)
returns boolean language plpgsql stable set search_path = '' as $$
declare
	v_action jsonb;
	v_type text;
	v_keys text[];
	v_field text;
begin
	-- 20260930708000: the call's own keys, each of its type.
	if jsonb_typeof(p_args) is distinct from 'object'
		or p_args - array['operationKey', 'machine', 'action', 'settleMs', 'look', 'intent'] <> '{}'::jsonb
		or not (p_args ?& array['operationKey', 'machine', 'action']) then
		return false; end if;
	if jsonb_typeof(p_args -> 'operationKey') is distinct from 'string'
		or (p_args ->> 'operationKey') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or jsonb_typeof(p_args -> 'machine') is distinct from 'string'
		or (p_args ->> 'machine') !~ '^[a-z0-9][a-z0-9-]{0,39}$' then
		return false; end if;
	if p_args ? 'settleMs' and not (jsonb_typeof(p_args -> 'settleMs') = 'number'
		and (p_args ->> 'settleMs')::numeric between 0 and 5000
		and (p_args ->> 'settleMs')::numeric = trunc((p_args ->> 'settleMs')::numeric)) then
		return false; end if;
	if p_args ? 'look' and jsonb_typeof(p_args -> 'look') <> 'boolean' then return false; end if;
	if p_args ? 'intent' and not (jsonb_typeof(p_args -> 'intent') = 'string'
		and char_length(p_args ->> 'intent') between 1 and 200
		and (p_args ->> 'intent') = btrim(p_args ->> 'intent')
		and (p_args ->> 'intent') !~ '[[:cntrl:]]') then
		return false; end if;
	v_action := p_args -> 'action';
	if jsonb_typeof(v_action) is distinct from 'object' or jsonb_typeof(v_action -> 'type') is distinct from 'string' then
		return false; end if;
	v_type := v_action ->> 'type';
	-- Each verb's closed keys; the verbs that are reviewed say why.
	v_keys := case v_type
		when 'click' then array['type', 'x', 'y', 'button']
		when 'double' then array['type', 'x', 'y']
		when 'move' then array['type', 'x', 'y']
		when 'drag' then array['type', 'x', 'y', 'toX', 'toY']
		when 'type' then array['type', 'text']
		when 'key' then array['type', 'keys']
		when 'scroll' then array['type', 'direction', 'steps', 'x', 'y']
		when 'open' then array['type', 'target'] end;
	if v_keys is null or v_action - v_keys <> '{}'::jsonb then return false; end if;
	if v_type in ('click', 'double', 'drag', 'type', 'key', 'open') and not p_args ? 'intent' then return false; end if;
	-- Positions: where the verb needs one, and each a whole pixel of a screen of at most 3840 x 2160.
	if (v_type in ('click', 'double', 'move', 'drag') and not (v_action ?& array['x', 'y']))
		or (v_type = 'drag' and not (v_action ?& array['toX', 'toY']))
		or (v_type = 'scroll' and (v_action ? 'x') <> (v_action ? 'y')) then
		return false; end if;
	foreach v_field in array array['x', 'y', 'toX', 'toY'] loop
		if v_action ? v_field and not (jsonb_typeof(v_action -> v_field) = 'number'
			and (v_action ->> v_field)::numeric between 0 and (case when v_field in ('x', 'toX') then 3839 else 2159 end)
			and (v_action ->> v_field)::numeric = trunc((v_action ->> v_field)::numeric)) then
			return false; end if;
	end loop;
	return case v_type
		when 'click' then not v_action ? 'button'
			or (jsonb_typeof(v_action -> 'button') = 'string' and v_action ->> 'button' in ('left', 'middle', 'right'))
		when 'type' then jsonb_typeof(v_action -> 'text') = 'string'
			and char_length(v_action ->> 'text') between 1 and 500
			and translate(v_action ->> 'text', E'\n\t', '') !~ '[[:cntrl:]]'
		when 'key' then jsonb_typeof(v_action -> 'keys') = 'array'
			and jsonb_array_length(v_action -> 'keys') between 1 and 16
			and not exists (select 1 from jsonb_array_elements(v_action -> 'keys') as key(value)
				where jsonb_typeof(key.value) <> 'string' or (key.value #>> '{}') !~ '^[A-Za-z0-9_][A-Za-z0-9_+]{0,39}$')
		when 'scroll' then jsonb_typeof(v_action -> 'direction') = 'string' and v_action ->> 'direction' in ('up', 'down')
			and (not v_action ? 'steps' or (jsonb_typeof(v_action -> 'steps') = 'number'
				and (v_action ->> 'steps')::numeric between 1 and 30
				and (v_action ->> 'steps')::numeric = trunc((v_action ->> 'steps')::numeric)))
		when 'open' then jsonb_typeof(v_action -> 'target') = 'string'
			and char_length(v_action ->> 'target') between 1 and 2000
			and ((v_action ->> 'target') ~ '^(https?|file)://[!-~]+$'
				or (v_action ->> 'target') ~ '^/[^[:cntrl:]]*$')
		else true end;
end
$$;
revoke all on function public.qorpera_valid_machine_screen_call(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The coding executor's read: where the machine runs, and the action the receipt holds ----------------------------------

-- The executor runs the helper only after this read, on the machine's node (or forwards the request to that node's
-- executor, which reads it again and never forwards). A look is a request with neither receipt nor envelope; an action
-- has both. The run's live tool authority in a company conversation; for an action, the call (exactly machine_screen's
-- of this machine, its arguments checked) and its own executing receipt, then the run's wake may still work (a wake
-- whose public output is final acts no more); the machine of the run's company and environment, not removed (for an action, of the
-- name the call gives); running now on its placement, reserved, with a known boot, or MACHINE_NOT_RUNNING. Every other
-- failure raises. Plain reads, and the machine's last use moved when it is more than 30 seconds old.
create function public.qorpera_authorize_machine_screen(p_binding jsonb, p_scope jsonb, p_receipt_id uuid,
	p_envelope text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
	v_envelope jsonb;
	v_operation jsonb;
	v_args jsonb;
	v_identity jsonb;
	v_run public.qorpera_execution_runs%rowtype;
	v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype;
	v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
	-- 20260930708000: the request: a look (no receipt, no envelope) or an action (both).
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_scope) is distinct from 'object'
		or p_scope - 'machineId' <> '{}'::jsonb or coalesce(p_scope ->> 'machineId' !~ v_uuid, true)
		or (p_receipt_id is null) <> (p_envelope is null) or coalesce(octet_length(p_envelope) > 65536, false) then
		raise exception 'Machine screen request is malformed' using errcode = '22023'; end if;
	if p_envelope is not null then
		begin
			v_envelope := p_envelope::jsonb;
		exception when others then
			raise exception 'Machine screen request is malformed' using errcode = '22023';
		end;
		v_operation := v_envelope -> 'operation';
		if jsonb_typeof(v_envelope) is distinct from 'object'
			or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
			or v_operation ->> 'tool' is distinct from 'machine_screen'
			or v_operation ->> 'toolVersion' is distinct from 'qorpera.machine-tools/v1'
			or not coalesce(public.qorpera_valid_machine_screen_call(v_operation -> 'arguments'), false)
			or v_operation #>> '{arguments,operationKey}' is distinct from v_operation ->> 'logicalOperationKey'
			or v_operation -> 'target' is distinct from jsonb_build_object('realm', 'company_machine',
				'machineId', p_scope ->> 'machineId') then
			raise exception 'Machine screen request is malformed' using errcode = '22023'; end if;
		v_args := v_operation -> 'arguments';
	end if;
	-- The run's live tool authority: a company conversation's run (a worker's too: machines are the company's).
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	if v_identity ->> 'audienceKind' is distinct from 'company' then
		raise exception 'Machines belong to company conversations' using errcode = '42501'; end if;
	select run.* into v_run from public.qorpera_execution_runs as run where run.id = (p_binding ->> 'runId')::uuid;
	if v_args is not null then
		-- This call's own receipt, still executing; then the run's wake may still work (an action is work; a look is not).
		select receipt.* into v_receipt from public.qorpera_run_operation_receipts as receipt
		where receipt.id = p_receipt_id and receipt.run_id = v_run.id;
		if not found or v_receipt.status is distinct from 'executing' or v_receipt.operation_kind is distinct from 'cloud_tool'
			or v_receipt.requires_company_revision is distinct from false
			or v_receipt.input_sha256 is distinct from encode(extensions.digest(convert_to(p_envelope, 'UTF8'), 'sha256'), 'hex')
			or v_receipt.logical_operation_key is distinct from 'machine_screen:' || (v_operation ->> 'logicalOperationKey') then
			raise exception 'Machine screen receipt is unavailable' using errcode = '42501'; end if;
		perform public.qorpera_assert_wake_work_allowed(v_run.id);
	end if;
	-- The machine the request names, of the run's company and environment (and of the call's name).
	select machine.* into v_machine from public.qorpera_company_machines as machine
	where machine.id = (p_scope ->> 'machineId')::uuid and machine.profile_id = v_run.profile_id
		and machine.environment_id = v_run.environment_id and machine.removed_at is null
		and (v_args is null or machine.name = v_args ->> 'machine');
	if not found then
		raise exception 'Machine screen authority is unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	-- The agent hears this one: it starts or wakes the machine.
	if v_machine.desired_state <> 'running' or v_placement.id is null or v_placement.running_at is null
		or v_placement.boot_id is null or not coalesce(public.qorpera_company_machine_placement_reserved(v_placement.id), false) then
		return jsonb_build_object('schema', 'qorpera.machine-screen-authority/v1', 'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING', 'machine', v_machine.name); end if;
	-- An agent used it: the idle rule's clock, moved at most every 30 seconds (a look-act-look loop is many calls).
	update public.qorpera_company_machines set last_used_at = clock_timestamp()
	where id = v_machine.id and last_used_at < clock_timestamp() - interval '30 seconds';
	return jsonb_build_object(
		'schema', 'qorpera.machine-screen-authority/v1',
		'state', 'authorized',
		-- Where it runs: the executor of its node, and the instance and boot there.
		'machineId', v_machine.id,
		'placementId', v_placement.id,
		'bootId', v_placement.boot_id,
		'executorOwner', v_placement.owner,
		'providerId', v_placement.binding ->> 'providerId',
		'runId', v_run.id,
		'staffAgentId', v_run.staff_agent_id,
		'requesterUserId', v_run.requested_by_user_id,
		-- What the helper does: the action as the receipt holds it (null for a look), the settle time and the look.
		'receiptId', p_receipt_id,
		'action', v_args -> 'action',
		'settleMs', case when v_args is null then null
			else coalesce((v_args ->> 'settleMs')::numeric::integer, case when v_args #>> '{action,type}' = 'open' then 2500 else 500 end) end,
		'look', case when v_args is null then null else coalesce((v_args ->> 'look')::boolean, true) end);
end
$$;
revoke all on function public.qorpera_authorize_machine_screen(jsonb, jsonb, uuid, text)
	from public, anon, authenticated, qorpera_secret_broker;
grant execute on function public.qorpera_authorize_machine_screen(jsonb, jsonb, uuid, text) to service_role;

-- 3. The operations a run's observations may name, after save_coding_value (20260930705000) ---------------------------------

do $$ begin execute pg_temp.machine_screen_patched('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	array[$old$/* 20260930705000 */'save_coding_value',$old$,
	$new$/* 20260930705000 */'save_coding_value',/* 20260930708000 */'machine_screen',$new$]); end $$;

-- 4. The deploy guard: every new or patched body carries the marker ------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_valid_machine_screen_call(jsonb)',
		'public.qorpera_authorize_machine_screen(jsonb,jsonb,uuid,text)',
		'public.qorpera_record_runtime_observation(uuid,jsonb)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930708000') = 0 then
			raise exception '20260930708000 marker is missing in %', v_function; end if;
	end loop;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure),
			'20260930705000') = 0 then
		raise exception '20260930708000: the observations'' list lost its 20260930705000 marker'; end if;
	if (select provolatile from pg_proc where oid = 'public.qorpera_valid_machine_screen_call(jsonb)'::regprocedure) <> 's' then
		raise exception '20260930708000: the call check is not STABLE'; end if;
end $guard$;

drop function pg_temp.machine_screen_patched(regprocedure, text[]);
