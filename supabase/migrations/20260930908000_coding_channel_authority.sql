set local lock_timeout = '3s';

create function public.qorpera_authorize_coding_channel(
	p_binding jsonb,
	p_scope jsonb,
	p_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_authority jsonb;
	v_worker_id uuid;
	v_vm_id uuid;
	v_request_id uuid;
	v_turn integer;
	v_session public.qorpera_coding_sessions%rowtype;
	v_machine public.qorpera_coding_machines%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Coding channel authority required' using errcode = '42501';
	end if;
	if p_kind is null
		or p_kind not in ('exec', 'sftp')
		or jsonb_typeof(p_scope) is distinct from 'object'
		or p_scope - array['requestId', 'workerId', 'vmId', 'turn'] <> '{}'::jsonb
		or jsonb_typeof(p_scope -> 'turn') is distinct from 'number' then
		raise exception 'Coding channel scope invalid' using errcode = '22023';
	end if;
	begin
		v_worker_id := (p_scope ->> 'workerId')::uuid;
		v_vm_id := (p_scope ->> 'vmId')::uuid;
		v_request_id := (p_scope ->> 'requestId')::uuid;
		v_turn := (p_scope ->> 'turn')::integer;
	exception
		when invalid_text_representation or numeric_value_out_of_range then
			raise exception 'Coding channel scope invalid' using errcode = '22023';
	end;
	if v_worker_id is null or v_vm_id is null or v_request_id is null or v_turn is null or v_turn < 1 then
		raise exception 'Coding channel scope invalid' using errcode = '22023';
	end if;

	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	if v_worker_id::text is distinct from v_authority #>> '{coding,workerId}'
		or v_vm_id::text is distinct from v_authority #>> '{coding,vmId}'
		or v_request_id::text is distinct from v_authority #>> '{coding,turnId}'
		or v_turn::text is distinct from v_authority #>> '{coding,sequence}' then
		raise exception 'Coding channel scope differs' using errcode = '42501';
	end if;
	if v_authority #>> '{coding,harness}' is distinct from 'claude-code'
		or v_authority #> '{coding,submission}' is distinct from 'null'::jsonb then
		raise exception 'Coding channel authority unavailable' using errcode = '42501';
	end if;

	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker_id;
	select * into v_machine from public.qorpera_coding_machines where id = v_vm_id;
	if v_session.worker_id is null
		or v_session.attached_machine_id is distinct from v_vm_id
		or v_machine.id is null
		or v_machine.removing_at is not null
		or v_machine.removed_at is not null
		or not exists (
			select 1
			from public.qorpera_coding_executors as executor
			where executor.environment_id = v_machine.environment_id
				and executor.owner = v_machine.owner
				and executor.nas_machine_id_sha256 = v_machine.machine_id_sha256
		)
		or not exists (
			select 1
			from public.qorpera_runtime_machine_allocations as allocation
			join public.qorpera_runtime_node_demands as demand on demand.allocation_id = allocation.id
			join public.qorpera_runtime_nodes as node on node.id = demand.node_id
			where allocation.id = v_machine.id
				and allocation.released_at is null
				and allocation.instance_sha256 = v_machine.instance_sha256
				and demand.reserved_at is not null
				and demand.released_at is null
				and demand.suspended_at is null
				and node.machine_id_sha256 = v_machine.machine_id_sha256
		) then
		return jsonb_build_object(
			'schema', 'qorpera.coding-channel-authority/v1',
			'state', 'refused',
			'reason', 'MACHINE_NOT_RUNNING'
		);
	end if;

	if v_machine.new_disk_at is not null then
		return jsonb_build_object(
			'schema', 'qorpera.coding-channel-authority/v1',
			'state', 'refused',
			'reason', 'MACHINE_NEW_DISK'
		);
	end if;

	return jsonb_build_object(
		'schema', 'qorpera.coding-channel-authority/v1',
		'state', 'authorized',
		'workerId', v_worker_id,
		'vmId', v_machine.id,
		'requestId', v_request_id,
		'turn', v_turn,
		'executorOwner', v_machine.owner,
		'providerId', v_machine.binding ->> 'providerId'
	);
end
$$;

revoke all on function public.qorpera_authorize_coding_channel(jsonb, jsonb, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

grant execute on function public.qorpera_authorize_coding_channel(jsonb, jsonb, text)
	to service_role;
