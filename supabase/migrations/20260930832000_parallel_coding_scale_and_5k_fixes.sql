set local lock_timeout = '3s';

do $$ begin
	if to_regclass('public.qorpera_claude_member_parallel_caps') is not null then
		raise exception 'Parallel coding scale and 5k fixes (20260930832000) are already applied'; end if;
	if to_regclass('public.qorpera_claude_parallel_runs') is null
		or to_regclass('public.qorpera_coding_session_loads') is null then
		raise exception 'Parallel coding scale and 5k fixes (20260930832000) need 20260930810000 and 20260930828000 first';
	end if;
end $$;

create function pg_temp.w4c_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception '20260930832000 anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

alter table public.qorpera_claude_parallel_runs
	drop constraint qorpera_claude_parallel_runs_cap_check,
	add constraint qorpera_claude_parallel_runs_cap_check check (cap between 1 and 64);

alter table public.qorpera_claude_worker_leases
	drop constraint qorpera_claude_worker_leases_slot_check,
	add constraint qorpera_claude_worker_leases_slot_check check (slot between 1 and 64);

create table public.qorpera_claude_member_parallel_caps (
	member_user_id uuid primary key references auth.users(id) on delete cascade,
	cap smallint not null check (cap between 1 and 64),
	updated_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_claude_member_parallel_caps enable row level security;
revoke all on public.qorpera_claude_member_parallel_caps from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_claude_worker_run_cap(p_member_user_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
	select coalesce(
		(select member_cap.cap from public.qorpera_claude_member_parallel_caps member_cap
			where member_cap.member_user_id = p_member_user_id),
		public.qorpera_claude_worker_run_cap()
	)::integer
$$;
revoke all on function public.qorpera_claude_worker_run_cap(uuid) from public, anon, authenticated, service_role,
	qorpera_secret_broker;

create or replace function public.qorpera_claude_worker_waits(p_worker public.qorpera_runtime_workers)
returns boolean language sql stable security definer set search_path = '' as $$
	select p_worker.harness is not distinct from 'claude-code' and (select count(*)
		from public.qorpera_claude_worker_leases lease
		where lease.owner_user_id = p_worker.requested_by_user_id and public.qorpera_claude_worker_lease_live(lease))
		>= public.qorpera_claude_worker_run_cap(p_worker.requested_by_user_id)
$$;
revoke all on function public.qorpera_claude_worker_waits(public.qorpera_runtime_workers)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create or replace function public.qorpera_claude_worker_lease_take(p_worker public.qorpera_runtime_workers, p_wake_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_taken uuid; v_cap integer; v_slot integer;
begin
	if p_worker.harness is distinct from 'claude-code' or p_worker.requested_by_user_id is null or p_wake_id is null then
		raise exception 'Only a Claude Code worker takes a Claude Code lease' using errcode = '22023'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera_claude_worker_lease:' || p_worker.requested_by_user_id::text, 0));
	v_cap := public.qorpera_claude_worker_run_cap(p_worker.requested_by_user_id);
	-- WHY: a cap lowered while more runs are live starts nothing until they are fewer, though a lower slot is free.
	if (select count(*) from public.qorpera_claude_worker_leases lease
		where lease.owner_user_id = p_worker.requested_by_user_id and public.qorpera_claude_worker_lease_live(lease)) >= v_cap then
		return false; end if;
	for v_slot in 1..v_cap loop
		insert into public.qorpera_claude_worker_leases as lease (owner_user_id, slot, worker_id, wake_id, claude_login_id)
		values (p_worker.requested_by_user_id, v_slot, p_worker.id, p_wake_id, p_worker.claude_login_id)
		on conflict (owner_user_id, slot) do update set worker_id = excluded.worker_id, wake_id = excluded.wake_id,
			claude_login_id = excluded.claude_login_id, taken_at = clock_timestamp()
		where not public.qorpera_claude_worker_lease_live(lease)
		returning lease.wake_id into v_taken;
		if v_taken is not distinct from p_wake_id then return true; end if;
		v_taken := null;
	end loop;
	return false;
end $$;
revoke all on function public.qorpera_claude_worker_lease_take(public.qorpera_runtime_workers, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_set_claude_parallel_cap(p_cap smallint, p_member_user_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Claude parallel cap operator authority required' using errcode = '42501'; end if;
	if p_member_user_id is null then
		if p_cap is null or p_cap not between 1 and 64 then
			raise exception 'Claude parallel cap must be between 1 and 64' using errcode = '22023'; end if;
		insert into public.qorpera_claude_parallel_runs(only_row, cap) values (true, p_cap)
		on conflict (only_row) do update set cap = excluded.cap;
		return jsonb_build_object('schema', 'qorpera.claude-parallel-cap/v1', 'scope', 'global', 'cap', p_cap::integer);
	end if;
	if p_cap is null then
		delete from public.qorpera_claude_member_parallel_caps where member_user_id = p_member_user_id;
		return jsonb_build_object('schema', 'qorpera.claude-parallel-cap/v1', 'scope', 'member',
			'memberUserId', p_member_user_id, 'overrideCap', null, 'effectiveCap', public.qorpera_claude_worker_run_cap());
	end if;
	if p_cap not between 1 and 64 then
		raise exception 'Claude parallel cap must be between 1 and 64' using errcode = '22023'; end if;
	insert into public.qorpera_claude_member_parallel_caps(member_user_id, cap, updated_at)
	values (p_member_user_id, p_cap, clock_timestamp())
	on conflict (member_user_id) do update set cap = excluded.cap, updated_at = clock_timestamp();
	return jsonb_build_object('schema', 'qorpera.claude-parallel-cap/v1', 'scope', 'member',
		'memberUserId', p_member_user_id, 'overrideCap', p_cap::integer, 'effectiveCap', p_cap::integer);
end $$;

create function public.qorpera_get_claude_parallel_cap(p_member_user_id uuid default null)
returns integer language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Claude parallel cap operator authority required' using errcode = '42501'; end if;
	if p_member_user_id is null then return public.qorpera_claude_worker_run_cap(); end if;
	return public.qorpera_claude_worker_run_cap(p_member_user_id);
end $$;

revoke all on function public.qorpera_set_claude_parallel_cap(smallint, uuid),
	public.qorpera_get_claude_parallel_cap(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_set_claude_parallel_cap(smallint, uuid),
	public.qorpera_get_claude_parallel_cap(uuid) to service_role;

alter table public.qorpera_coding_executors
	alter column session_cpu_millis set default 1000,
	alter column session_memory_bytes set default 2147483648,
	add column max_attached_sessions integer not null default 6 check (max_attached_sessions between 1 and 64);

update public.qorpera_coding_executors
set session_cpu_millis = case when session_cpu_millis = 0 then 1000 else session_cpu_millis end,
	session_memory_bytes = case when session_memory_bytes = 0 then 2147483648 else session_memory_bytes end
where session_cpu_millis = 0 or session_memory_bytes = 0;

create function public.qorpera_configure_coding_session_size(p_environment_id uuid, p_owner text, p_cpu_millis bigint,
	p_memory_bytes bigint, p_max_attached_sessions integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding machine operator authority required' using errcode = '42501'; end if;
	update public.qorpera_coding_executors
	set session_cpu_millis = p_cpu_millis, session_memory_bytes = p_memory_bytes,
		max_attached_sessions = p_max_attached_sessions, updated_at = clock_timestamp()
	where environment_id = p_environment_id and owner = p_owner;
	if not found then raise exception 'Coding executor unavailable' using errcode = '42501'; end if;
end
$$;
revoke all on function public.qorpera_configure_coding_session_size(uuid, text, bigint, bigint, integer)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_configure_coding_session_size(uuid, text, bigint, bigint, integer) to service_role;

select pg_temp.w4c_patch('public.qorpera_coding_executor_enroll(uuid,text)'::regprocedure, array[
$old$	-- WHY: 20260930828000 (step 5k): copy template session sizing onto auto-enrolled executors.
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, vm_policy, nas_policy,
		nas_machine_id_sha256, machine_sleep_after_seconds, machine_remove_after_seconds, session_archive_after_seconds,
		session_cpu_millis, session_memory_bytes)
	values (p_environment_id, v_owner, true, case when p_harness is null then v_like.harnesses else array[p_harness] end,
		v_like.vm_policy, v_like.nas_policy,
		v_like.nas_machine_id_sha256, v_like.machine_sleep_after_seconds, v_like.machine_remove_after_seconds,
		v_like.session_archive_after_seconds, v_like.session_cpu_millis, v_like.session_memory_bytes)$old$,
$new$	-- WHY: 20260930828000 (step 5k) and 20260930832000: copy template session sizing and attachment cap onto auto-enrolled executors.
	insert into public.qorpera_coding_executors(environment_id, owner, enabled, harnesses, vm_policy, nas_policy,
		nas_machine_id_sha256, machine_sleep_after_seconds, machine_remove_after_seconds, session_archive_after_seconds,
		session_cpu_millis, session_memory_bytes, max_attached_sessions)
	values (p_environment_id, v_owner, true, case when p_harness is null then v_like.harnesses else array[p_harness] end,
		v_like.vm_policy, v_like.nas_policy,
		v_like.nas_machine_id_sha256, v_like.machine_sleep_after_seconds, v_like.machine_remove_after_seconds,
		v_like.session_archive_after_seconds, v_like.session_cpu_millis, v_like.session_memory_bytes,
		v_like.max_attached_sessions)$new$
]);

create function public.qorpera_coding_machine_full(p_machine public.qorpera_coding_machines, p_worker_id uuid,
	p_session_cpu_millis bigint, p_session_memory_bytes bigint, p_max_attached_sessions integer)
returns boolean language sql stable security definer set search_path = '' as $$
	with machine as (
		select (p_machine.binding ->> 'cpus')::bigint * 1000 as cpu_millis, (p_machine.binding ->> 'memoryBytes')::bigint as memory_bytes),
	placed as (
		select count(*) as active_sessions,
			coalesce(sum(greatest(p_session_cpu_millis, coalesce(load.cpu_millis, 0))), 0) as cpu_millis,
			coalesce(sum(greatest(p_session_memory_bytes, coalesce(load.memory_bytes, 0))), 0) as memory_bytes
		from public.qorpera_coding_sessions session
		left join public.qorpera_coding_session_loads load on load.worker_id = session.worker_id
		where session.worker_id <> p_worker_id and session.archived_at is null
			and session.worker_id in (
				select attached.worker_id from public.qorpera_coding_sessions attached where attached.attached_machine_id = p_machine.id
				union
				select homed.worker_id from public.qorpera_coding_sessions homed where homed.vm_allocation_id = p_machine.id
				union
				select place.worker_id from public.qorpera_coding_session_loads place where place.machine_id = p_machine.id
			)
			and (
				(session.attached_at is not null and session.attached_machine_id = p_machine.id and session.attachment_until > clock_timestamp())
				or (session.phase in ('preparing', 'running', 'publishing') and session.lease_until > clock_timestamp()
					and coalesce(load.machine_id, session.vm_allocation_id) = p_machine.id)
			)),
	arriving as (
		select greatest(p_session_cpu_millis, coalesce(max(load.cpu_millis), 0)) as cpu_millis,
			greatest(p_session_memory_bytes, coalesce(max(load.memory_bytes), 0)) as memory_bytes
		from public.qorpera_coding_session_loads load where load.worker_id = p_worker_id)
	select coalesce(p_machine.full_until > clock_timestamp(), false)
		or placed.active_sessions >= greatest(coalesce(p_max_attached_sessions, 6), 1)
		or placed.cpu_millis + least(arriving.cpu_millis, machine.cpu_millis) > machine.cpu_millis
		or placed.memory_bytes + least(arriving.memory_bytes, machine.memory_bytes) > machine.memory_bytes
	from machine, placed, arriving
$$;

create or replace function public.qorpera_coding_machine_full(p_machine public.qorpera_coding_machines, p_worker_id uuid,
	p_session_cpu_millis bigint, p_session_memory_bytes bigint)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_coding_machine_full(
		p_machine,
		p_worker_id,
		p_session_cpu_millis,
		p_session_memory_bytes,
		coalesce((select executor.max_attached_sessions from public.qorpera_coding_executors executor
			where executor.environment_id = p_machine.environment_id and executor.owner = p_machine.owner), 6)
	)
$$;

revoke all on function public.qorpera_coding_machine_full(public.qorpera_coding_machines, uuid, bigint, bigint, integer),
	public.qorpera_coding_machine_full(public.qorpera_coding_machines, uuid, bigint, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.w4c_patch('public.qorpera_plan_coding_machine(uuid,uuid,text,text)'::regprocedure, array[
$old$	v_candidate public.qorpera_coding_machines%rowtype; v_number integer;$old$,
$new$	v_candidate public.qorpera_coding_machines%rowtype; v_number integer;
	v_candidate_executor public.qorpera_coding_executors%rowtype; v_other_node_reusable boolean := false;
	v_session_attached boolean := false; v_rehomed boolean := false; v_volume_pinned_here boolean := false;$new$,
$old$	if exists (select 1 from public.qorpera_coding_storage_volumes volume where volume.environment_id = v_worker.environment_id
		and volume.member_user_id = v_worker.owner_user_id
		and (volume.owner <> v_session.lease_owner or volume.machine_id_sha256 <> p_machine_id_sha256)) then
		return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;$old$,
$new$	-- WHY: Only a session's own NAS volume pins that session to a node; another session's volume must not block cross-node overflow.
	if exists (select 1 from public.qorpera_coding_storage_volumes volume where volume.worker_id = v_worker.id
		and (volume.owner <> v_session.lease_owner or volume.machine_id_sha256 <> p_machine_id_sha256)) then
		return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;
	v_volume_pinned_here := exists (select 1 from public.qorpera_coding_storage_volumes volume where volume.worker_id = v_worker.id
		and volume.owner = v_session.lease_owner and volume.machine_id_sha256 = p_machine_id_sha256);$new$,
$old$	if v_machine.id is not null then
		if v_machine.owner <> v_session.lease_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256 then
			return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;
		if v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
			if v_machine.instance_sha256 is null then
				update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
					'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_executor.vm_policy where id = v_machine.id returning * into v_machine;
			else
				update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_machine.id returning * into v_machine;
			end if;
		end if;
		if v_machine.retire_requested_at is not null or v_machine.removing_at is not null then
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
	end if;$old$,
$new$	if v_machine.id is not null then
		v_session_attached := v_session.attached_machine_id = v_machine.id
			and v_session.attached_at is not null and v_session.attachment_until > clock_timestamp();
		if v_machine.owner <> v_session.lease_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256 then
			if v_session_attached then
				return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;
			select * into v_candidate_executor from public.qorpera_coding_executors executor
			where executor.environment_id = v_machine.environment_id and executor.owner = v_machine.owner;
			if v_machine.retire_requested_at is not null or v_machine.removing_at is not null
				or public.qorpera_coding_machine_full(v_machine, v_worker.id,
					coalesce(v_candidate_executor.session_cpu_millis, v_executor.session_cpu_millis),
					coalesce(v_candidate_executor.session_memory_bytes, v_executor.session_memory_bytes),
					coalesce(v_candidate_executor.max_attached_sessions, v_executor.max_attached_sessions)) then
				v_rehomed := true;
				v_machine := null;
			else
				return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb;
			end if;
		else
			if v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
				if v_machine.instance_sha256 is null then
					update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
						'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_executor.vm_policy where id = v_machine.id returning * into v_machine;
				else
					update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_machine.id returning * into v_machine;
				end if;
			end if;
			if v_machine.retire_requested_at is not null or v_machine.removing_at is not null then
				if v_session_attached then
					return jsonb_build_object('state','refused','reason','MACHINE_RETIRING','machineId',v_machine.id); end if;
				v_rehomed := true;
				v_machine := null;
			elsif not v_session_attached
				and public.qorpera_coding_machine_full(v_machine, v_worker.id, v_executor.session_cpu_millis,
					v_executor.session_memory_bytes, v_executor.max_attached_sessions) then
				v_rehomed := true;
				v_machine := null;
			end if;
		end if;
	end if;
	if v_machine.id is null then
		-- WHY: 20260930828000 (step 5k) and 20260930832000: skip full or retiring remote candidates so overflow allocates
		-- locally instead of returning NODE_NOT_PREFERRED, while preferring any non-full reusable remote candidate.
		v_number := 1;
		for v_candidate in select * from public.qorpera_coding_machines machine
			where machine.profile_id = v_worker.profile_id and machine.environment_id = v_worker.environment_id
				and machine.member_user_id = v_worker.owner_user_id and machine.staff_agent_id = v_worker.staff_agent_id
				and machine.repository = v_repository and machine.setup_digest = v_setup_digest and machine.kind = 'member'
				and machine.removed_at is null
			order by machine.number for update
		loop
			if v_candidate.number = v_number then v_number := v_number + 1; end if;
			if v_candidate.retire_requested_at is not null or v_candidate.removing_at is not null then
				continue; end if;
			if v_candidate.owner <> v_session.lease_owner or v_candidate.machine_id_sha256 <> p_machine_id_sha256 then
				if v_volume_pinned_here then
					continue; end if;
				select * into v_candidate_executor from public.qorpera_coding_executors executor
				where executor.environment_id = v_candidate.environment_id and executor.owner = v_candidate.owner;
				if public.qorpera_coding_machine_full(v_candidate, v_worker.id,
					coalesce(v_candidate_executor.session_cpu_millis, v_executor.session_cpu_millis),
					coalesce(v_candidate_executor.session_memory_bytes, v_executor.session_memory_bytes),
					coalesce(v_candidate_executor.max_attached_sessions, v_executor.max_attached_sessions)) then
					continue; end if;
				v_other_node_reusable := true;
				continue;
			end if;
			if v_candidate.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
				if v_candidate.instance_sha256 is null then
					update public.qorpera_coding_machines set binding = (binding - array['providerId','providerPolicySha256','project','imageFingerprint',
						'bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes']) || v_executor.vm_policy where id = v_candidate.id returning * into v_candidate;
				else
					update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp()) where id = v_candidate.id returning * into v_candidate;
				end if;
			end if;
			if v_candidate.retire_requested_at is null and v_candidate.removing_at is null
				and not public.qorpera_coding_machine_full(v_candidate, v_worker.id, v_executor.session_cpu_millis,
					v_executor.session_memory_bytes, v_executor.max_attached_sessions) then
				v_machine := v_candidate;
				exit;
			end if;
		end loop;
		if v_machine.id is null and v_other_node_reusable then
			return '{"state":"refused","reason":"NODE_NOT_PREFERRED"}'::jsonb; end if;
	end if;$new$,
$old$	if v_machine.instance_sha256 is null then
		if exists (select 1 from public.qorpera_coding_machines previous
			join public.qorpera_runtime_node_demands demand on demand.allocation_id = previous.id
			where previous.id = v_session.vm_allocation_id and previous.id is distinct from v_machine.id and previous.removed_at is null
				and demand.reserved_at is not null and demand.released_at is null and demand.suspended_at is null) then
			return '{"state":"refused","reason":"PREVIOUS_MACHINE_AWAKE"}'::jsonb; end if;$old$,
$new$	if v_machine.instance_sha256 is null then
		if not v_rehomed and exists (select 1 from public.qorpera_coding_machines previous
			join public.qorpera_runtime_node_demands demand on demand.allocation_id = previous.id
			where previous.id = v_session.vm_allocation_id and previous.id is distinct from v_machine.id and previous.removed_at is null
				and demand.reserved_at is not null and demand.released_at is null and demand.suspended_at is null) then
			return '{"state":"refused","reason":"PREVIOUS_MACHINE_AWAKE"}'::jsonb; end if;$new$,
$old$		exception when sqlstate 'P0F01' then return v_node;
		end;
	end if;$old$,
$new$		exception when sqlstate 'P0F01' then return v_node;
		end;
	elsif v_rehomed and v_session.vm_allocation_id is distinct from v_machine.id then
		-- WHY: Re-home detached sessions off full or retiring VMs and take in the target machine's read set under its FOR UPDATE lock.
		update public.qorpera_coding_sessions set vm_allocation_id = v_machine.id, updated_at = clock_timestamp() where worker_id = v_worker.id;
		begin
			perform public.qorpera_coding_machine_take_in(v_worker.environment_id, v_worker.profile_id, v_machine.id, turn.run_id,
				public.qorpera_folder_run_reader(v_worker.profile_id, turn.run_id))
			from public.qorpera_coding_machine_turns(v_machine.id) turn where turn.worker_id = v_worker.id order by turn.run_id;
		exception when insufficient_privilege then
			if sqlerrm <> 'A released read is no longer readable' then raise; end if;
			update public.qorpera_coding_machines set new_disk_at = coalesce(new_disk_at, clock_timestamp()),
				folder_restart_at = coalesce(folder_restart_at, clock_timestamp()) where id = v_machine.id;
		end;
	end if;$new$
]);

select pg_temp.w4c_patch('public.qorpera_keep_coding_attachments(uuid,text,text,text,jsonb)'::regprocedure, array[
$old$		v_entries := v_entries || jsonb_build_array(case when v_refusal is null then jsonb_build_object('workerId',v_session.worker_id,'state','kept',
			'attachmentToken',v_session.attachment_token,'validForMs',59000,$old$,
$new$		v_entries := v_entries || jsonb_build_array(case when v_refusal is null then jsonb_build_object('workerId',v_session.worker_id,'state','kept',
			'attachmentToken',v_session.attachment_token,'validForMs',59000,
			'guestUid',(select u.guest_uid from public.qorpera_coding_session_uids u where u.worker_id = v_session.worker_id),$new$
]);

comment on table public.qorpera_claude_member_parallel_caps is
	'20260930832000: per-member parallel Claude Code run cap overrides (1..64), falling back to qorpera_claude_parallel_runs.';
comment on function public.qorpera_set_claude_parallel_cap(smallint, uuid) is
	'20260930832000: operator RPC to set global or per-member Claude Code parallel run cap (1..64, or null to clear member override).';
comment on function public.qorpera_get_claude_parallel_cap(uuid) is
	'20260930832000: operator RPC returning the effective global or per-member Claude Code parallel run cap.';
comment on function public.qorpera_configure_coding_session_size(uuid, text, bigint, bigint, integer) is
	'20260930832000: configures minimum per-session CPU (millis), memory (bytes), and max_attached_sessions cap on an executor.';
comment on function public.qorpera_coding_machine_full(public.qorpera_coding_machines, uuid, bigint, bigint, integer) is
	'20260930832000: internal helper checking active-only session load, max_attached_sessions, and fullness hints for an arriving session.';
comment on function public.qorpera_plan_coding_machine(uuid, uuid, text, text) is
	'20260930828000 (step 5k) / 20260930832000: plans sessions with active-only capacity accounting, cross-node overflow, and detached re-homing off full or retiring machines.';
comment on function public.qorpera_coding_executor_enroll(uuid, text) is
	'20260930828000 (step 5k) / 20260930832000: copies session_cpu_millis, session_memory_bytes, and max_attached_sessions from the template executor row on auto-enrollment.';

drop function pg_temp.w4c_patch(regprocedure, text[]);
