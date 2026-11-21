set local lock_timeout = '3s';

create function pg_temp.s5k_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception 'Step 5k anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

alter table public.qorpera_coding_executors
	add column session_cpu_millis bigint not null default 0 check (session_cpu_millis between 0 and 1000000000),
	add column session_memory_bytes bigint not null default 0 check (session_memory_bytes between 0 and 1099511627776);

create function public.qorpera_configure_coding_session_size(p_environment_id uuid, p_owner text, p_cpu_millis bigint,
	p_memory_bytes bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding machine operator authority required' using errcode = '42501'; end if;
	update public.qorpera_coding_executors
	set session_cpu_millis = p_cpu_millis, session_memory_bytes = p_memory_bytes, updated_at = clock_timestamp()
	where environment_id = p_environment_id and owner = p_owner;
	if not found then raise exception 'Coding executor unavailable' using errcode = '42501'; end if;
end
$$;

select pg_temp.s5k_patch('public.qorpera_coding_executor_enroll(uuid,text)'::regprocedure, array[
$old$	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, vm_policy, nas_policy,
		nas_machine_id_sha256, machine_sleep_after_seconds, machine_remove_after_seconds, session_archive_after_seconds)
	values (p_environment_id, v_owner, true, case when p_harness is null then v_like.harnesses else array[p_harness] end,
		v_like.vm_policy, v_like.nas_policy,
		v_like.nas_machine_id_sha256, v_like.machine_sleep_after_seconds, v_like.machine_remove_after_seconds,
		v_like.session_archive_after_seconds)$old$,
$new$	-- WHY: 20260930828000 (step 5k): copy template session sizing onto auto-enrolled executors.
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, vm_policy, nas_policy,
		nas_machine_id_sha256, machine_sleep_after_seconds, machine_remove_after_seconds, session_archive_after_seconds,
		session_cpu_millis, session_memory_bytes)
	values (p_environment_id, v_owner, true, case when p_harness is null then v_like.harnesses else array[p_harness] end,
		v_like.vm_policy, v_like.nas_policy,
		v_like.nas_machine_id_sha256, v_like.machine_sleep_after_seconds, v_like.machine_remove_after_seconds,
		v_like.session_archive_after_seconds, v_like.session_cpu_millis, v_like.session_memory_bytes)$new$
]);

create table public.qorpera_coding_session_loads (
	worker_id uuid primary key references public.qorpera_coding_sessions(worker_id) on delete cascade,
	machine_id uuid not null,
	cpu_millis bigint not null default 0 check (cpu_millis between 0 and 1000000000),
	memory_bytes bigint not null default 0 check (memory_bytes between 0 and 1099511627776),
	measured_at timestamptz
);
create index qorpera_coding_session_loads_machine on public.qorpera_coding_session_loads (machine_id);
alter table public.qorpera_coding_session_loads enable row level security;
revoke all on public.qorpera_coding_session_loads from public, anon, authenticated, service_role, qorpera_secret_broker;

insert into public.qorpera_coding_session_loads (worker_id, machine_id)
select worker_id, vm_allocation_id
from public.qorpera_coding_sessions
where vm_allocation_id is not null and archived_at is null
on conflict (worker_id) do nothing;

alter table public.qorpera_coding_machines add column full_until timestamptz;

create function public.qorpera_record_coding_machine_load(p_machine_id uuid, p_owner text, p_binding_text text,
	p_machine_id_sha256 text, p_load jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype; v_workers uuid[]; v_recorded integer;
begin
	v_machine := public.qorpera_coding_machine_owned(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if p_load is null or jsonb_typeof(p_load) <> 'object' or p_load - array['schema','full','sessions'] <> '{}'::jsonb
		or p_load ->> 'schema' is distinct from 'qorpera.coding-machine-load/v1'
		or jsonb_typeof(p_load -> 'full') is distinct from 'boolean' or jsonb_typeof(p_load -> 'sessions') is distinct from 'array'
		or pg_column_size(p_load) > 1048576
		or exists (select 1 from jsonb_array_elements(p_load -> 'sessions') entry
			where case when jsonb_typeof(entry) <> 'object' then true
				else entry - array['workerId','cpuMillis','memoryBytes'] <> '{}'::jsonb
					or coalesce(entry ->> 'workerId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
					or jsonb_typeof(entry -> 'cpuMillis') is distinct from 'number' or coalesce(entry ->> 'cpuMillis','') !~ '^(0|[1-9][0-9]{0,8})$'
					or case when jsonb_typeof(entry -> 'memoryBytes') = 'number' and coalesce(entry ->> 'memoryBytes','') ~ '^(0|[1-9][0-9]{0,12})$'
						then (entry ->> 'memoryBytes')::bigint > 1099511627776 else true end end)
		or (select count(distinct entry ->> 'workerId') from jsonb_array_elements(p_load -> 'sessions') entry)
			<> jsonb_array_length(p_load -> 'sessions') then
		raise exception 'Coding machine load invalid' using errcode = '22023'; end if;
	update public.qorpera_coding_machines
	set full_until = case when (p_load ->> 'full')::boolean then clock_timestamp() + interval '2 minutes' end
	where id = v_machine.id and removed_at is null and ((p_load ->> 'full')::boolean or full_until is not null);
	-- WHY: Update-only (never insert) so FK checks cannot lock qorpera_coding_sessions after
	-- qorpera_coding_machines, which would invert qorpera_keep_coding_attachments's lock order.
	select coalesce(array_agg(locked.worker_id order by locked.worker_id), '{}') into v_workers
	from (
		select load.worker_id
		from public.qorpera_coding_session_loads load
		join public.qorpera_coding_sessions session on session.worker_id = load.worker_id
		where load.worker_id in (select (entry ->> 'workerId')::uuid from jsonb_array_elements(p_load -> 'sessions') entry)
			and session.vm_allocation_id = v_machine.id and session.archived_at is null
		order by load.worker_id
		for update of load
	) locked;
	update public.qorpera_coding_session_loads load
	set cpu_millis = (entry ->> 'cpuMillis')::bigint, memory_bytes = (entry ->> 'memoryBytes')::bigint, measured_at = clock_timestamp()
	from jsonb_array_elements(p_load -> 'sessions') entry
	join public.qorpera_coding_sessions session on session.worker_id = (entry ->> 'workerId')::uuid
	where load.worker_id = any(v_workers) and load.worker_id = session.worker_id
		and session.vm_allocation_id = v_machine.id and session.archived_at is null;
	get diagnostics v_recorded = row_count;
	return jsonb_build_object('schema','qorpera.coding-machine-load-recorded/v1','machineId',v_machine.id,'sessions',v_recorded);
end
$$;

create function public.qorpera_coding_machine_full(p_machine public.qorpera_coding_machines, p_worker_id uuid,
	p_session_cpu_millis bigint, p_session_memory_bytes bigint)
returns boolean language sql stable security definer set search_path = '' as $$
	with machine as (
		select (p_machine.binding ->> 'cpus')::bigint * 1000 as cpu_millis, (p_machine.binding ->> 'memoryBytes')::bigint as memory_bytes),
	placed as (
		select coalesce(sum(greatest(p_session_cpu_millis, coalesce(load.cpu_millis, 0))), 0) as cpu_millis,
			coalesce(sum(greatest(p_session_memory_bytes, coalesce(load.memory_bytes, 0))), 0) as memory_bytes
		from public.qorpera_coding_sessions session
		left join public.qorpera_coding_session_loads load on load.worker_id = session.worker_id
		where session.worker_id <> p_worker_id and session.archived_at is null
			and session.worker_id in (select homed.worker_id from public.qorpera_coding_sessions homed where homed.vm_allocation_id = p_machine.id
				union select place.worker_id from public.qorpera_coding_session_loads place where place.machine_id = p_machine.id)),
	arriving as (
		select greatest(p_session_cpu_millis, coalesce(max(load.cpu_millis), 0)) as cpu_millis,
			greatest(p_session_memory_bytes, coalesce(max(load.memory_bytes), 0)) as memory_bytes
		from public.qorpera_coding_session_loads load where load.worker_id = p_worker_id)
	select coalesce(p_machine.full_until > clock_timestamp(), false)
		or placed.cpu_millis + least(arriving.cpu_millis, machine.cpu_millis) > machine.cpu_millis
		or placed.memory_bytes + least(arriving.memory_bytes, machine.memory_bytes) > machine.memory_bytes
	from machine, placed, arriving
$$;

select pg_temp.s5k_patch('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure, array[
$old$	v_binding text; v_node jsonb; v_result jsonb; v_repository text; v_setup_digest text;$old$,
$new$	v_binding text; v_node jsonb; v_result jsonb; v_repository text; v_setup_digest text;
	v_candidate public.qorpera_coding_machines%rowtype; v_number integer;$new$,
$old$		and (machine.id = v_session.vm_allocation_id or (machine.setup_digest = v_setup_digest and machine.number = 1))
		and exists (select 1 from public.qorpera_runtime_machine_allocations allocation$old$,
$new$		and (machine.id = v_session.vm_allocation_id or machine.setup_digest = v_setup_digest)
		and exists (select 1 from public.qorpera_runtime_machine_allocations allocation$new$,
$old$		and (machine.id = v_session.vm_allocation_id or (machine.setup_digest = v_setup_digest and machine.number = 1))
	order by machine.id is distinct from v_session.vm_allocation_id limit 1 for update;$old$,
$new$		and machine.id = v_session.vm_allocation_id
	order by machine.id is distinct from v_session.vm_allocation_id limit 1 for update;$new$,
$old$		if v_machine.retire_requested_at is not null or v_machine.removing_at is not null then
			return jsonb_build_object('state','refused','reason','MACHINE_RETIRING','machineId',v_machine.id); end if;
	end if;$old$,
$new$		if v_machine.retire_requested_at is not null or v_machine.removing_at is not null then
			return jsonb_build_object('state','refused','reason','MACHINE_RETIRING','machineId',v_machine.id); end if;
	end if;
	if v_machine.id is null then
		-- WHY: 20260930828000 (step 5k): pick the lowest-number non-full machine or allocate the lowest free number.
		v_number := 1;
		for v_candidate in select * from public.qorpera_coding_machines machine
			where machine.profile_id = v_worker.profile_id and machine.environment_id = v_worker.environment_id
				and machine.member_user_id = v_worker.owner_user_id and machine.staff_agent_id = v_worker.staff_agent_id
				and machine.repository = v_repository and machine.setup_digest = v_setup_digest and machine.kind = 'member'
				and machine.removed_at is null
			order by machine.number for update
		loop
			if v_candidate.number = v_number then v_number := v_number + 1; end if;
			if v_candidate.owner <> v_session.lease_owner or v_candidate.machine_id_sha256 <> p_machine_id_sha256 then
				return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;
			if v_candidate.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
				if v_candidate.instance_sha256 is null then
					update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
						'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_executor.vm_policy where id = v_candidate.id returning * into v_candidate;
				else
					update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_candidate.id returning * into v_candidate;
				end if;
			end if;
			if v_candidate.retire_requested_at is null and v_candidate.removing_at is null
				and not public.qorpera_coding_machine_full(v_candidate, v_worker.id, v_executor.session_cpu_millis, v_executor.session_memory_bytes) then
				v_machine := v_candidate;
				exit;
			end if;
		end loop;
	end if;$new$,
$old$					v_worker.staff_agent_id, v_repository, v_setup_digest, 1)$old$,
$new$					v_worker.staff_agent_id, v_repository, v_setup_digest, v_number)$new$,
$old$	v_result := jsonb_build_object('schema','qorpera.coding-machine-plan/v1','state','planned','machineId',v_machine.id,'binding',v_machine.binding);$old$,
$new$	insert into public.qorpera_coding_session_loads(worker_id, machine_id) values (v_worker.id, v_machine.id)
	on conflict (worker_id) do update set machine_id = excluded.machine_id
	where public.qorpera_coding_session_loads.machine_id is distinct from excluded.machine_id;
	v_result := jsonb_build_object('schema','qorpera.coding-machine-plan/v1','state','planned','machineId',v_machine.id,'binding',v_machine.binding);$new$
]);

revoke all on function public.qorpera_coding_machine_full(public.qorpera_coding_machines, uuid, bigint, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_configure_coding_session_size(uuid, text, bigint, bigint),
	public.qorpera_record_coding_machine_load(uuid, text, text, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_configure_coding_session_size(uuid, text, bigint, bigint),
	public.qorpera_record_coding_machine_load(uuid, text, text, text, jsonb) to service_role;

comment on table public.qorpera_coding_session_loads is
	'20260930828000 (step 5k): each coding session''s planned machine place and last measured CPU/memory load.';
comment on function public.qorpera_configure_coding_session_size(uuid, text, bigint, bigint) is
	'20260930828000 (step 5k): configures minimum per-session CPU (millis) and memory (bytes) sizing on an executor.';
comment on function public.qorpera_record_coding_machine_load(uuid, text, text, text, jsonb) is
	'20260930828000 (step 5k): records measured per-session CPU/memory load and machine fullness hint without locking qorpera_coding_sessions.';
comment on function public.qorpera_coding_machine_full(public.qorpera_coding_machines, uuid, bigint, bigint) is
	'20260930828000 (step 5k): internal helper determining whether a coding machine is full for an arriving session.';
comment on function public.qorpera_plan_coding_machine(uuid, uuid, text, text) is
	'20260930828000 (step 5k): plans a session onto its own live machine or the lowest-number non-retiring non-full machine for (agent, repo, setup_digest), allocating the lowest free number on overflow.';
comment on function public.qorpera_coding_executor_enroll(uuid, text) is
	'20260930828000 (step 5k): copies session_cpu_millis and session_memory_bytes from the template executor row on auto-enrollment.';

drop function pg_temp.s5k_patch(regprocedure, text[]);
