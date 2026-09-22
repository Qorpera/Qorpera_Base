-- Step 9, part 3: the Codex executor on coding sessions.
--
-- The kernel of part 1 (20260922230000) owns the session: its lease, its
-- phases, its events, the turn's admission through the wake bus under the
-- owner's sponsor, and the Order 5 completion path. This migration gives the
-- executor what it needs around that: the deployment policies it runs under
-- (VM, NAS), the retained repository VM as a plan plus a capacity-ledger
-- allocation, the machine and cleanup authority it re-fetches before every
-- LXD effect, the storage binding it may mount, and the turn itself as seen
-- from the runner: the authority the native harness re-reads while it works,
-- the command authority the executor checks before it starts anything in the
-- VM, the durable submission the harness leaves behind (a commit to publish,
-- or a question for the owner), and the turn description the executor waits
-- on. Everything from #200 that had its own worker, request, completion or
-- listener is gone; what is carried over is rekeyed on the worker and the
-- session lease.

-- ---------------------------------------------------------------------------
-- 1. Deployment policies and the turn's submission
-- ---------------------------------------------------------------------------
alter table public.qorpera_coding_executors
	add column vm_policy jsonb,
	add column nas_policy jsonb,
	add column nas_machine_id_sha256 text check (nas_machine_id_sha256 ~ '^[0-9a-f]{64}$');

alter table public.qorpera_coding_sessions
	add column submission jsonb check (submission is null or (jsonb_typeof(submission) = 'object' and pg_column_size(submission) <= 8192)),
	add column submission_receipt_id uuid references public.qorpera_run_operation_receipts(id) on delete restrict,
	add constraint qorpera_coding_sessions_submission_receipt check ((submission is null) = (submission_receipt_id is null));

-- The turn id the guest protocol pins (its "requestId"): derived, never stored,
-- the same on the executor (coding-executor-host id("turn", worker:sequence))
-- and here, so neither side can name a turn the other did not.
create function public.qorpera_coding_turn_id(p_worker_id uuid, p_sequence integer)
returns uuid language sql immutable set search_path = '' as $$
	select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
	from (select encode(extensions.digest(convert_to('qorpera.coding-host/turn/' || p_worker_id::text || ':' || p_sequence::text, 'utf8'), 'sha256'), 'hex') as h) digest
$$;

-- ---------------------------------------------------------------------------
-- 2. The retained repository VM: plan, capacity allocation, node demand
-- ---------------------------------------------------------------------------
create table public.qorpera_coding_vm_plans (
	worker_id uuid primary key references public.qorpera_runtime_workers(id) on delete restrict,
	owner text not null check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	machine_id_sha256 text not null check (machine_id_sha256 ~ '^[0-9a-f]{64}$'),
	allocation_id uuid not null unique,
	binding jsonb not null,
	instance_sha256 text not null check (instance_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_coding_vm_plans enable row level security;
revoke all on public.qorpera_coding_vm_plans from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Repository VMs consume the same company and node capacity ledger as every
-- other machine. They belong to a worker, never to a runner or an office. The
-- existing job, office, login and account-refresh sources keep their exact rule
-- (text as of 20260919007000).
alter table public.qorpera_runtime_machine_allocations
	add column coding_worker_id uuid unique references public.qorpera_runtime_workers(id) on delete restrict,
	drop constraint qorpera_runtime_machine_allocation_source,
	add constraint qorpera_runtime_machine_allocation_source check(
		(coding_worker_id is null and (
			(run_id is not null and runner_id is not null and office_id is null and computer_generation is null
				and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
			or (run_id is null and runner_id is null and office_id is not null and computer_generation is not null and computer_generation>0
				and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
			or (run_id is null and runner_id is null and office_id is null and computer_generation is null
				and num_nonnulls(login_session_id,account_refresh_request_id)=1 and login_compute_identity_id is not null)))
		or (coding_worker_id is not null and run_id is null and runner_id is null and office_id is null and computer_generation is null
			and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null));
alter table public.qorpera_runtime_node_providers
	drop constraint qorpera_runtime_node_providers_provider_kind_check,
	drop constraint qorpera_runtime_node_providers_check,
	add constraint qorpera_runtime_node_providers_provider_kind_check check (provider_kind in ('native','office','login','coding')),
	add constraint qorpera_runtime_node_providers_check check ((provider_kind in ('native','login','coding') and provider_id ~ '^[a-z][a-z0-9_-]{0,63}$')
		or (provider_kind='office' and provider_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));

create function pg_temp.coding_executor_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding executor integration differs: %', p_target; end if;
	execute replace(v_definition, p_old, p_new);
end
$$;
select pg_temp.coding_executor_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$p_provider_kind not in ('native','office','login')$old$, $new$p_provider_kind not in ('native','office','login','coding')$new$);
select pg_temp.coding_executor_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$or (p_provider_kind='native' and$old$,
	$new$or (p_provider_kind='coding' and (v_allocation.coding_worker_id is null or v_allocation.runner_id is not null or v_allocation.provider_adapter<>p_provider_id))
  or (p_provider_kind='native' and$new$);

-- Trusted deployment configuration, not an image verifier: the deployment
-- verifier checks signed image/bootstrap and isolation before these exact
-- values are configured. No default is installed.
create function public.qorpera_configure_coding_vm_policy(p_environment_id uuid, p_owner text, p_policy jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding VM operator authority required' using errcode = '42501'; end if;
	if jsonb_typeof(p_policy) is distinct from 'object'
		or (select count(*) from jsonb_object_keys(p_policy)) <> 10
		or p_policy - array['providerId','providerPolicySha256','project','imageFingerprint','bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes'] <> '{}'::jsonb
		or coalesce(p_policy ->> 'providerId','') !~ '^[a-z][a-z0-9_-]{0,63}$'
		or exists (select 1 from unnest(array['providerPolicySha256','imageFingerprint','bootstrapSha256']) k where coalesce(p_policy ->> k,'') !~ '^[0-9a-f]{64}$')
		or exists (select 1 from unnest(array['project','storagePool','network']) k where coalesce(p_policy ->> k,'') !~ '^[a-z][a-z0-9-]{0,62}$')
		or exists (select 1 from unnest(array['cpus','memoryBytes','rootDiskBytes']) k where jsonb_typeof(p_policy -> k) is distinct from 'number' or coalesce(p_policy ->> k,'') !~ '^[1-9][0-9]{0,12}$') then
		raise exception 'Coding VM policy invalid' using errcode = '22023'; end if;
	if (p_policy ->> 'cpus')::bigint > 64 or (p_policy ->> 'memoryBytes')::bigint > 1099511627776 or (p_policy ->> 'rootDiskBytes')::bigint > 1099511627776 then
		raise exception 'Coding VM policy exceeds bound' using errcode = '22023'; end if;
	update public.qorpera_coding_executors set vm_policy = p_policy where environment_id = p_environment_id and owner = p_owner;
	if not found then raise exception 'Coding executor unavailable' using errcode = '42501'; end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. NAS placement: immutable for the life of this first storage backend
-- ---------------------------------------------------------------------------
create table public.qorpera_coding_storage_volumes (
	worker_id uuid primary key references public.qorpera_runtime_workers(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_files(environment_id) on delete restrict,
	owner text not null,
	machine_id_sha256 text not null check (machine_id_sha256 ~ '^[0-9a-f]{64}$'),
	writer_generation bigint not null check (writer_generation = 1),
	binding jsonb not null,
	created_at timestamptz not null default clock_timestamp()
);
alter table public.qorpera_coding_storage_volumes enable row level security;
revoke all on public.qorpera_coding_storage_volumes from public, anon, authenticated, service_role, qorpera_secret_broker;

create function public.qorpera_configure_coding_nas_policy(p_environment_id uuid, p_owner text, p_machine_id_sha256 text, p_policy jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_mount text := p_policy ->> 'mountPoint'; v_root text := p_policy ->> 'rootPath'; v_address text := p_policy ->> 'serverAddress';
	v_existing public.qorpera_coding_executors%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding NAS operator authority required' using errcode = '42501'; end if;
	if jsonb_typeof(p_policy) is distinct from 'object' or p_policy is distinct from jsonb_build_object(
			'schema','qorpera.coding-nas-policy/v1','mountPoint',v_mount,'rootPath',v_root,'serverAddress',v_address,'source',p_policy ->> 'source')
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$'
		or coalesce(v_address,'') !~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
		or exists (select 1 from unnest(string_to_array(v_address,'.')) octet where octet::integer > 255 or octet::integer::text <> octet)
		or coalesce(p_policy ->> 'source','') not like v_address || ':/%'
		or exists (select 1 from unnest(array[v_mount, v_root, substring(p_policy ->> 'source' from length(v_address) + 2)]) path
			where path is null or octet_length(path) > 2048 or path !~ '^/' or path ~ '[[:space:][:cntrl:]\\]'
				or exists (select 1 from unnest(string_to_array(substring(path from 2),'/')) component where component in ('','.','..')))
		or not (v_root = v_mount or starts_with(v_root, v_mount || '/')) then
		raise exception 'Coding NAS policy invalid' using errcode = '22023'; end if;
	select * into v_existing from public.qorpera_coding_executors where environment_id = p_environment_id and owner = p_owner for update;
	if not found then raise exception 'Coding executor unavailable' using errcode = '42501'; end if;
	if exists (select 1 from public.qorpera_coding_storage_volumes where environment_id = p_environment_id and owner = p_owner)
		and (v_existing.nas_policy is distinct from p_policy or v_existing.nas_machine_id_sha256 is distinct from p_machine_id_sha256) then
		raise exception 'Coding NAS placement cannot be rebound; physical recovery required' using errcode = '55000'; end if;
	update public.qorpera_coding_executors set nas_policy = p_policy, nas_machine_id_sha256 = p_machine_id_sha256
	where environment_id = p_environment_id and owner = p_owner;
end
$$;

-- Internal: called with the worker locked. Pins the volume descriptor with its
-- first machine reservation; every later call must match it exactly.
create function public.qorpera_assert_coding_storage(p_worker_id uuid, p_owner text, p_storage jsonb, p_machine_id_sha256 text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype; v_executor public.qorpera_coding_executors%rowtype;
	v_expected jsonb; v_root text; v_volume public.qorpera_coding_storage_volumes%rowtype;
begin
	select * into strict v_worker from public.qorpera_runtime_workers where id = p_worker_id for update;
	select * into v_executor from public.qorpera_coding_executors where environment_id = v_worker.environment_id and owner = p_owner and enabled for share;
	if v_executor.nas_policy is null or v_executor.nas_machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Coding NAS placement unavailable' using errcode = '42501'; end if;
	v_root := (v_executor.nas_policy ->> 'rootPath') || '/workers/' || v_worker.profile_id::text || '/' || v_worker.environment_id::text || '/' || v_worker.id::text;
	v_expected := jsonb_build_object('schema','qorpera.coding-storage/v1','volumeId',v_worker.id,'workerId',v_worker.id,
		'companyId',v_worker.profile_id,'environmentId',v_worker.environment_id,'writerGeneration',1,'machineIdSha256',p_machine_id_sha256,
		'policy',v_executor.nas_policy,'dataSource',v_root || '/data','custodySource',v_root || '/guest-state',
		'dataTarget','/workspace','custodyTarget','/var/lib/qorpera-coding');
	if p_storage is distinct from v_expected then raise exception 'Coding NAS binding differs' using errcode = '42501'; end if;
	select * into v_volume from public.qorpera_coding_storage_volumes where worker_id = v_worker.id for update;
	if found then
		if v_volume.environment_id <> v_worker.environment_id or v_volume.owner <> p_owner or v_volume.machine_id_sha256 <> p_machine_id_sha256
			or v_volume.writer_generation <> 1 or v_volume.binding is distinct from v_expected then
			raise exception 'Coding NAS writer cannot be replaced by a lease' using errcode = '42501'; end if;
	else
		insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding)
		values (v_worker.id, v_worker.environment_id, p_owner, p_machine_id_sha256, 1, v_expected);
		update public.qorpera_coding_sessions set storage_volume_id = v_worker.id, updated_at = clock_timestamp()
		where worker_id = v_worker.id and storage_volume_id is null;
	end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Machine authority: re-fetched before every LXD effect, valid for seconds
-- ---------------------------------------------------------------------------
-- Run intent needs the session lease. The plan is pinned on first use; the
-- allocation and the node demand come from the ordinary capacity ledger, so a
-- company at its machine ceiling is refused with the same notification as any
-- other machine. Nothing here starts a model turn.
create function public.qorpera_authorize_coding_machine(p_worker_id uuid, p_lease_token uuid, p_binding_text text, p_machine_id_sha256 text, p_intent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_plan public.qorpera_coding_vm_plans%rowtype; v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_binding jsonb; v_policy jsonb; v_digest text; v_allocation_id uuid; v_node jsonb; v_ceiling integer; v_occupied bigint; v_valid integer;
begin
	if octet_length(coalesce(p_binding_text,'')) not between 2 and 16384 or p_intent is distinct from 'run' or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	v_binding := p_binding_text::jsonb;
	v_digest := encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex');
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update;
	if jsonb_typeof(v_binding) is distinct from 'object' or v_binding ->> 'schema' is distinct from 'qorpera.lxd-coding-vm/v2'
		or v_binding ->> 'workerId' is distinct from v_worker.id::text or v_binding ->> 'companyId' is distinct from v_worker.profile_id::text
		or v_binding ->> 'environmentId' is distinct from v_worker.environment_id::text or v_binding -> 'repository' is distinct from v_session.repository
		or coalesce(v_binding ->> 'allocationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
		raise exception 'Coding machine scope differs' using errcode = '42501'; end if;
	v_allocation_id := (v_binding ->> 'allocationId')::uuid;
	select * into v_plan from public.qorpera_coding_vm_plans where worker_id = v_worker.id for update;
	if found and (v_plan.allocation_id <> v_allocation_id or v_plan.binding <> v_binding or v_plan.instance_sha256 <> v_digest
		or v_plan.owner <> v_session.lease_owner or v_plan.machine_id_sha256 <> p_machine_id_sha256) then
		raise exception 'Coding machine plan cannot be rebound' using errcode = '42501'; end if;
	select vm_policy into v_policy from public.qorpera_coding_executors
	where environment_id = v_worker.environment_id and owner = v_session.lease_owner and enabled for share;
	if v_policy is null or v_binding - array['schema','workerId','allocationId','companyId','environmentId','repository','storage'] <> v_policy then
		raise exception 'Coding machine deployment policy unavailable' using errcode = '42501'; end if;
	perform public.qorpera_assert_coding_storage(v_worker.id, v_session.lease_owner, v_binding -> 'storage', p_machine_id_sha256);
	if v_plan.worker_id is null then
		insert into public.qorpera_coding_vm_plans(worker_id, owner, machine_id_sha256, allocation_id, binding, instance_sha256)
		values (v_worker.id, v_session.lease_owner, p_machine_id_sha256, v_allocation_id, v_binding, v_digest);
	end if;
	select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_allocation_id for update;
	if found then
		if v_allocation.profile_id <> v_worker.profile_id or v_allocation.coding_worker_id is distinct from v_worker.id or v_allocation.runner_id is not null
			or v_allocation.provider_adapter <> v_binding ->> 'providerId' or v_allocation.instance_sha256 <> v_digest or v_allocation.released_at is not null then
			raise exception 'Coding allocation cannot be rebound or revived' using errcode = '42501'; end if;
	else
		if v_session.vm_allocation_id is not null then raise exception 'Coding retained allocation missing' using errcode = '42501'; end if;
		select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id = v_worker.profile_id), 8) into v_ceiling;
		select count(*) into v_occupied from public.qorpera_runtime_machine_allocations where profile_id = v_worker.profile_id and released_at is null;
		if v_occupied >= v_ceiling then
			insert into public.qorpera_runtime_machine_refusals(allocation_id, profile_id, used, ceiling)
			values (v_allocation_id, v_worker.profile_id, v_occupied, v_ceiling) on conflict (allocation_id) do nothing;
			if found then
				insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
				select v_worker.profile_id, user_id, 'company_ceiling_tripped', jsonb_build_object('schema','qorpera.member-notification.machine-capacity/v1',
					'dimension','machines','used',v_occupied,'ceiling',v_ceiling,'allocationId',v_allocation_id), 'machines:' || v_allocation_id::text
				from public.qorpera_profile_members where profile_id = v_worker.profile_id and role in ('owner','admin')
				on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
			end if;
			return '{"state":"refused","reason":"MACHINE_CAPACITY_EXHAUSTED"}'::jsonb;
		end if;
		insert into public.qorpera_runtime_machine_allocations(id, profile_id, coding_worker_id, provider_adapter, instance_sha256)
		values (v_allocation_id, v_worker.profile_id, v_worker.id, v_binding ->> 'providerId', v_digest) returning * into v_allocation;
	end if;
	if v_session.vm_allocation_id is null then
		update public.qorpera_coding_sessions set vm_allocation_id = v_allocation_id, updated_at = clock_timestamp() where worker_id = v_worker.id;
	elsif v_session.vm_allocation_id <> v_allocation_id then
		raise exception 'Coding session allocation differs' using errcode = '42501'; end if;
	v_node := public.qorpera_reserve_runtime_node_machine(v_allocation_id, 'coding', v_binding ->> 'providerId', v_binding ->> 'providerPolicySha256', v_digest,
		p_machine_id_sha256, (v_binding ->> 'cpus')::bigint * 1000, (v_binding ->> 'memoryBytes')::bigint);
	if v_node ->> 'state' <> 'reserved' then return v_node; end if;
	v_valid := least((v_node ->> 'validForMs')::integer, floor(extract(epoch from v_session.lease_until - clock_timestamp()) * 1000)::integer);
	if v_valid < 1 then raise exception 'Coding lease expired' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.coding-vm-admission/v1','workerId',v_worker.id,'allocationId',v_allocation_id,
		'instanceSha256',v_digest,'intent','run','validForMs',v_valid,'nodeId',v_node -> 'nodeId','nodeVersion',v_node -> 'nodeVersion');
end
$$;

-- Cleanup custody belongs to the executor that planned the machine, on the node
-- that planned it, for as long as the allocation stands. It survives the lease:
-- an executor may always stop what it started. It never creates, moves or
-- resumes a machine, and never releases retained capacity.
create function public.qorpera_authorize_coding_cleanup(p_worker_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan public.qorpera_coding_vm_plans%rowtype; v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_binding jsonb; v_digest text; v_node jsonb;
begin
	if auth.role() is distinct from 'service_role' or octet_length(coalesce(p_binding_text,'')) not between 2 and 16384
		or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding cleanup custody required' using errcode = '42501'; end if;
	v_binding := p_binding_text::jsonb;
	v_digest := encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex');
	select * into v_plan from public.qorpera_coding_vm_plans where worker_id = p_worker_id for share;
	if v_plan.worker_id is null or v_plan.owner <> p_owner or v_plan.machine_id_sha256 <> p_machine_id_sha256
		or v_plan.binding is distinct from v_binding or v_plan.instance_sha256 <> v_digest then
		raise exception 'Coding cleanup custody differs' using errcode = '42501'; end if;
	select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_plan.allocation_id for share;
	if v_allocation.id is null or v_allocation.coding_worker_id is distinct from p_worker_id or v_allocation.instance_sha256 <> v_digest
		or v_allocation.released_at is not null then
		raise exception 'Coding cleanup allocation custody differs' using errcode = '42501'; end if;
	select jsonb_build_object('nodeId', n.id, 'nodeVersion', n.version) into v_node
	from public.qorpera_runtime_node_demands d join public.qorpera_runtime_nodes n on n.id = d.node_id
	where d.allocation_id = v_allocation.id and d.provider_kind = 'coding' and d.provider_id = v_allocation.provider_adapter
		and d.policy_sha256 = v_binding ->> 'providerPolicySha256' and d.released_at is null and n.machine_id_sha256 = p_machine_id_sha256;
	if v_node is null then raise exception 'Coding cleanup node custody differs' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.coding-vm-admission/v1','workerId',p_worker_id,'allocationId',v_allocation.id,
		'instanceSha256',v_digest,'intent','stop','validForMs',5000,'nodeId',v_node -> 'nodeId','nodeVersion',v_node -> 'nodeVersion');
end
$$;

-- What an executor may stop: the exact retained binding it planned, or proof
-- that it never planned one. Missing data is never evidence of absence.
create function public.qorpera_describe_coding_cleanup(p_worker_id uuid, p_owner text, p_machine_id_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_plan public.qorpera_coding_vm_plans%rowtype; v_session public.qorpera_coding_sessions%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding cleanup custody required' using errcode = '42501'; end if;
	select * into v_session from public.qorpera_coding_sessions where worker_id = p_worker_id;
	if v_session.worker_id is null then raise exception 'Coding session is unavailable' using errcode = '42501'; end if;
	select * into v_plan from public.qorpera_coding_vm_plans where worker_id = p_worker_id;
	if v_plan.worker_id is null then
		if v_session.vm_allocation_id is not null then raise exception 'Coding cleanup plan missing' using errcode = '42501'; end if;
		return jsonb_build_object('schema','qorpera.coding-cleanup-absent/v1','workerId',p_worker_id,'allocationId',null);
	end if;
	if v_plan.owner <> p_owner or v_plan.machine_id_sha256 <> p_machine_id_sha256 then
		raise exception 'Coding cleanup custody differs' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.coding-cleanup/v1','workerId',p_worker_id,'allocationId',v_plan.allocation_id,'binding',v_plan.binding);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The turn as the runner sees it
-- ---------------------------------------------------------------------------
-- The native harness runs the turn as an ordinary wake run under the owner's
-- sponsor. This is its authority: the same native tool authority every run
-- has, bounded by the session lease, plus the coding scope it may act in. It
-- is re-read continuously while the model streams.
create function public.qorpera_authorize_coding_turn(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run public.qorpera_execution_runs%rowtype; v_wake public.qorpera_wake_occurrences%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_session public.qorpera_coding_sessions%rowtype; v_authority jsonb; v_valid integer;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_run.id and source_kind = 'worker-dispatch';
	if v_wake.id is null or v_wake.payload ->> 'species' is distinct from 'coding' then
		raise exception 'Coding turn authority unavailable' using errcode = '42501'; end if;
	select * into v_worker from public.qorpera_runtime_workers where id = v_wake.source_id;
	select * into v_session from public.qorpera_coding_sessions where worker_id = v_worker.id;
	if v_worker.id is null or v_session.worker_id is null or v_worker.species <> 'coding' or v_worker.state <> 'active'
		or v_worker.occurrence_id is distinct from v_wake.id or v_session.phase <> 'running'
		or v_session.lease_token is null or v_session.lease_until <= clock_timestamp()
		or (v_wake.payload #>> '{coding,sequence}')::integer is distinct from v_worker.sequence
		or v_session.vm_allocation_id is null then
		raise exception 'Coding turn authority unavailable' using errcode = '42501'; end if;
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	v_valid := least((v_authority ->> 'validForMs')::integer, floor(extract(epoch from v_session.lease_until - clock_timestamp()) * 1000)::integer);
	if v_valid < 1 then raise exception 'Coding session lease expired' using errcode = '42501'; end if;
	return v_authority || jsonb_build_object('validForMs', v_valid, 'coding', jsonb_build_object(
		'workerId', v_worker.id, 'sequence', v_worker.sequence, 'turnId', public.qorpera_coding_turn_id(v_worker.id, v_worker.sequence),
		'vmId', v_session.vm_allocation_id, 'harness', v_session.harness, 'model', v_session.model, 'repository', v_session.repository,
		'branch', v_session.branch, 'baseSha', v_session.base_sha, 'harnessSessionRef', v_session.harness_session_ref,
		'title', v_worker.title, 'goal', v_worker.dispatch ->> 'goal', 'definitionOfDone', v_worker.dispatch ->> 'definitionOfDone',
		'context', v_worker.dispatch ->> 'context', 'followUp', v_worker.dispatch ->> 'followUp',
		'pullRequest', v_session.pull_request, 'submission', v_session.submission));
end
$$;

-- Admission of the model turn: the ordinary company admission, with the catalog
-- pinned to the coding tools. The coding turn has no mouth, no Company File,
-- no connector and no secret tool; a catalog that names anything else is refused.
create function public.qorpera_begin_native_coding_execution(p_binding jsonb, p_binary_sha256 text, p_runtime_bundle_sha256 text,
	p_reasoning_policy_sha256 text, p_tool_catalog_text text, p_context_sha256 text, p_context_bytes integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_catalog jsonb;
begin
	perform public.qorpera_authorize_coding_turn(p_binding);
	v_catalog := p_tool_catalog_text::jsonb;
	if jsonb_typeof(v_catalog -> 'tools') is distinct from 'array' then raise exception 'Coding catalog invalid' using errcode = '22023'; end if;
	if jsonb_array_length(v_catalog -> 'tools') not between 4 and 5
		or (select count(distinct tool ->> 'name') from jsonb_array_elements(v_catalog -> 'tools') tool) <> jsonb_array_length(v_catalog -> 'tools')
		or exists (select 1 from jsonb_array_elements(v_catalog -> 'tools') tool
			where tool ->> 'name' not in ('coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask')) then
		raise exception 'Coding catalog must contain only coding tools' using errcode = '42501'; end if;
	return public.qorpera_begin_native_company_execution_v2(p_binding, p_binary_sha256, p_runtime_bundle_sha256,
		p_reasoning_policy_sha256, p_tool_catalog_text, p_context_sha256, p_context_bytes);
end
$$;

create function public.qorpera_record_coding_context_view(p_binding jsonb, p_view jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	if jsonb_typeof(p_view -> 'outputs') is distinct from 'array' then raise exception 'Coding context invalid' using errcode = '22023'; end if;
	if exists (select 1 from jsonb_array_elements(p_view -> 'outputs') output where output -> 'readId' is distinct from 'null'::jsonb or output ? 'capture') then
		raise exception 'Coding context cannot introduce Company File reads' using errcode = '42501'; end if;
	return public.qorpera_record_native_context_view((v_authority #>> '{identity,environmentId}')::uuid, p_binding, p_view);
end
$$;

-- The harness's durable word at the end of its turn: a commit to publish
-- ("finish") or a question for the owner ("ask"). Recorded once per turn as a
-- native tool operation; a replay must repeat it exactly. The executor reads it
-- back through qorpera_describe_coding_turn and acts on it, never on prose.
create function public.qorpera_submit_coding_turn(p_binding jsonb, p_submission jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_worker_id uuid; v_sequence integer; v_session public.qorpera_coding_sessions%rowtype;
	v_kind text := p_submission ->> 'kind'; v_receipt uuid := extensions.gen_random_uuid(); v_digest text; v_response jsonb;
begin
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	v_worker_id := (v_authority #>> '{coding,workerId}')::uuid;
	v_sequence := (v_authority #>> '{coding,sequence}')::integer;
	if jsonb_typeof(p_submission) is distinct from 'object' or pg_column_size(p_submission) > 8192
		or coalesce(p_submission ->> 'operationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or v_kind not in ('finish','ask')
		or jsonb_typeof(p_submission -> 'summary') is distinct from 'string' or btrim(p_submission ->> 'summary') = '' or octet_length(p_submission ->> 'summary') > 4000
		or (v_kind = 'finish' and (p_submission - array['kind','operationKey','summary','headSha'] <> '{}'::jsonb
			or coalesce(p_submission ->> 'headSha','') !~ '^[0-9a-f]{40}$'))
		or (v_kind = 'ask' and (p_submission - array['kind','operationKey','summary','question','options'] <> '{}'::jsonb
			or jsonb_typeof(p_submission -> 'question') is distinct from 'string' or btrim(p_submission ->> 'question') = '' or octet_length(p_submission ->> 'question') > 1000
			or (p_submission ? 'options' and (jsonb_typeof(p_submission -> 'options') <> 'array' or jsonb_array_length(p_submission -> 'options') > 6
				or exists (select 1 from jsonb_array_elements(p_submission -> 'options') o where jsonb_typeof(o) <> 'string' or btrim(o #>> '{}') = '' or octet_length(o #>> '{}') > 120))))) then
		raise exception 'Coding submission invalid' using errcode = '22023'; end if;
	select * into strict v_session from public.qorpera_coding_sessions where worker_id = v_worker_id for update;
	v_response := jsonb_build_object('schema','qorpera.coding-submission/v1','workerId',v_worker_id,'sequence',v_sequence,'kind',v_kind,
		'state','submitted','summary',p_submission ->> 'summary','headSha',p_submission ->> 'headSha','question',p_submission ->> 'question',
		'options',coalesce(p_submission -> 'options','[]'::jsonb),'operationKey',p_submission ->> 'operationKey');
	if v_session.submission is not null then
		if v_session.submission <> v_response then raise exception 'Coding submission replay differs' using errcode = '23505'; end if;
		return v_session.submission;
	end if;
	v_digest := encode(extensions.digest(p_submission::text, 'sha256'), 'hex');
	perform public.qorpera_begin_native_tool_operation(p_binding, v_receipt, 'coding-submit:' || (p_submission ->> 'operationKey'), v_digest, v_digest, false);
	perform public.qorpera_complete_native_tool_operation(p_binding, v_receipt, v_digest, v_response);
	update public.qorpera_coding_sessions set submission = v_response, submission_receipt_id = v_receipt, updated_at = clock_timestamp() where worker_id = v_worker_id;
	perform public.qorpera_coding_event(v_worker_id, v_sequence, 'text', 'harness',
		jsonb_build_object('text', p_submission ->> 'summary', 'submitted', v_kind));
	return v_response;
end
$$;

-- The turn as the executor waits on it: where the admitted run is, and what the
-- harness left behind. The executor completes the session from this, with its
-- lease, through qorpera_complete_coding_turn.
create function public.qorpera_describe_coding_turn(p_worker_id uuid, p_lease_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype; v_run public.qorpera_execution_runs%rowtype; v_job public.qorpera_runner_jobs%rowtype;
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	if v_worker.occurrence_id is not null then
		select * into v_wake from public.qorpera_wake_occurrences where id = v_worker.occurrence_id;
		if v_wake.run_id is not null then
			select * into v_run from public.qorpera_execution_runs where id = v_wake.run_id;
			select * into v_job from public.qorpera_runner_jobs where id = v_run.job_id;
		end if;
	end if;
	return jsonb_build_object('schema','qorpera.coding-turn-state/v1','workerId',v_worker.id,'sequence',v_worker.sequence,
		'turnId',public.qorpera_coding_turn_id(v_worker.id, v_worker.sequence),'phase',v_session.phase,'workerState',v_worker.state,
		'vmAllocationId',v_session.vm_allocation_id,'storageVolumeId',v_session.storage_volume_id,'baseSha',v_session.base_sha,
		'occurrenceId',v_worker.occurrence_id,'occurrenceStatus',v_wake.status,'runId',v_wake.run_id,'jobStatus',v_job.status,
		'jobError',v_job.last_error,'submission',v_session.submission,'pullRequest',v_session.pull_request);
end
$$;

-- Before the executor starts, reads or cancels a command in the VM for the
-- harness: the request came from this turn's run, its receipt is the run's own
-- operation, its bytes are the bytes the receipt hashed, and no submission has
-- ended the turn yet.
create function public.qorpera_authorize_coding_command(p_binding jsonb, p_scope jsonb, p_action text, p_command_id uuid, p_input_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_receipt public.qorpera_run_operation_receipts%rowtype;
begin
	if jsonb_typeof(p_scope) is distinct from 'object' or p_scope - array['requestId','workerId','vmId','turn'] <> '{}'::jsonb
		or p_action is null or p_action not in ('start','read','cancel') then
		raise exception 'Coding command scope invalid' using errcode = '22023'; end if;
	v_authority := public.qorpera_authorize_coding_turn(p_binding);
	if p_scope ->> 'workerId' is distinct from v_authority #>> '{coding,workerId}' or p_scope ->> 'vmId' is distinct from v_authority #>> '{coding,vmId}'
		or p_scope ->> 'requestId' is distinct from v_authority #>> '{coding,turnId}' or p_scope ->> 'turn' is distinct from v_authority #>> '{coding,sequence}' then
		raise exception 'Coding command scope differs' using errcode = '42501'; end if;
	select * into v_receipt from public.qorpera_run_operation_receipts where id = p_command_id;
	if not found or v_receipt.operation_kind <> 'cloud_tool' or left(v_receipt.logical_operation_key, length('coding_run_command:')) <> 'coding_run_command:'
		or v_receipt.requires_company_revision or v_receipt.run_id <> (p_binding ->> 'runId')::uuid
		or (p_action = 'start' and (v_receipt.status not in ('executing','completed') or v_receipt.input_sha256 is distinct from p_input_sha256
			or v_authority #> '{coding,submission}' is distinct from 'null'::jsonb)) then
		raise exception 'Coding command authority unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('authority', v_authority, 'inputSha256', v_receipt.input_sha256,
		'operationKey', substring(v_receipt.logical_operation_key from length('coding_run_command:') + 1));
end
$$;

-- A new turn starts clean: the previous submission belongs to the previous sequence.
create or replace function public.qorpera_coding_session_queue(p_worker public.qorpera_runtime_workers, p_action text, p_run_id uuid, p_text text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
	update public.qorpera_coding_sessions set phase = case p_action when 'dispatch' then 'queued' else 'input_ready' end,
		finished_at = null, lease_owner = null, lease_token = null, lease_until = null, submission = null, submission_receipt_id = null,
		updated_at = clock_timestamp()
	where worker_id = p_worker.id;
	perform public.qorpera_coding_event(p_worker.id, p_worker.sequence, case p_action when 'dispatch' then 'phase' else 'input' end,
		case p_action when 'dispatch' then 'kernel' else 'agent' end,
		case p_action when 'dispatch' then jsonb_build_object('phase','queued') else jsonb_build_object('text', p_text, 'runId', p_run_id) end);
end
$$;

-- A question may carry the choices the harness offered; the thread renders them as
-- answer buttons. The completion also consumes the turn's submission.
drop function public.qorpera_complete_coding_turn(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, integer);
create function public.qorpera_complete_coding_turn(p_worker_id uuid, p_lease_token uuid, p_outcome text, p_summary text, p_needs text default null,
	p_pull_request jsonb default null, p_checks jsonb default null, p_artifacts jsonb default null, p_harness_session_ref text default null,
	p_files_changed integer default null, p_options jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype; v_summary text := btrim(coalesce(p_summary,''));
	v_needs text := nullif(btrim(coalesce(p_needs,'')),''); v_report jsonb;
begin
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	if p_outcome not in ('succeeded','blocked','failed') or octet_length(v_summary) not between 1 and 4000
		or ((p_outcome = 'blocked') <> (v_needs is not null)) or octet_length(coalesce(v_needs,'')) > 1000
		or (p_pull_request is not null and (jsonb_typeof(p_pull_request) <> 'object'
			or p_pull_request - array['url','number','headSha'] <> '{}'::jsonb
			or p_pull_request ->> 'url' is distinct from 'https://github.com/' || (v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name') || '/pull/' || (p_pull_request ->> 'number')
			or coalesce(p_pull_request ->> 'headSha','') !~ '^[0-9a-f]{40}$'))
		or (p_checks is not null and jsonb_typeof(p_checks) <> 'array') or (p_artifacts is not null and jsonb_typeof(p_artifacts) <> 'array')
		or (p_files_changed is not null and p_files_changed < 0)
		or (p_options is not null and (v_needs is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) > 6
			or exists (select 1 from jsonb_array_elements(p_options) o where jsonb_typeof(o) <> 'string' or btrim(o #>> '{}') = '' or octet_length(o #>> '{}') > 120))) then
		raise exception 'Coding turn result is invalid' using errcode = '22023'; end if;
	perform 1 from public.qorpera_runtime_agent_todos where id = (select todo_id from public.qorpera_runtime_workers where id = v_session.worker_id) for update;
	select * into v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update;
	if v_worker.state <> 'active' then raise exception 'Worker was cancelled or has already reported' using errcode = '55000'; end if;
	v_report := jsonb_build_object('outcome', p_outcome, 'summary', v_summary, 'needs', v_needs, 'outputs', '[]'::jsonb,
		'pullRequest', coalesce(p_pull_request, v_session.pull_request), 'runId', null, 'sequence', v_worker.sequence)
		|| case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end;
	update public.qorpera_runtime_workers set state = p_outcome, result = v_report, reported_at = clock_timestamp(),
		completion_state = 'waiting', updated_at = clock_timestamp() where id = v_worker.id returning * into v_worker;
	insert into public.qorpera_runtime_worker_events(worker_id, sequence, kind, run_id, body)
	values (v_worker.id, v_worker.sequence, 'reported', null, v_report);
	update public.qorpera_coding_sessions set
		phase = case p_outcome when 'succeeded' then 'completed' when 'blocked' then 'awaiting_input' else 'failed' end,
		finished_at = case when p_outcome = 'blocked' then null else clock_timestamp() end,
		pull_request = coalesce(p_pull_request, pull_request), checks = coalesce(p_checks, checks), artifacts = coalesce(p_artifacts, artifacts),
		harness_session_ref = coalesce(p_harness_session_ref, harness_session_ref), files_changed = coalesce(p_files_changed, files_changed),
		lease_owner = null, lease_token = null, lease_until = null, submission = null, submission_receipt_id = null, updated_at = clock_timestamp()
	where worker_id = v_worker.id returning * into v_session;
	if p_pull_request is not null then
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'published', 'executor', p_pull_request); end if;
	perform public.qorpera_coding_event(v_worker.id, v_worker.sequence,
		case p_outcome when 'succeeded' then 'finished' when 'blocked' then 'needs_input' else 'failed' end, 'executor',
		jsonb_build_object('summary', v_summary, 'needs', v_needs) || case when p_options is not null then jsonb_build_object('options', p_options) else '{}'::jsonb end);
	perform public.qorpera_touch_agent_todo(v_worker.todo_id, null);
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;
revoke all on function public.qorpera_complete_coding_turn(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, integer, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_complete_coding_turn(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, integer, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_coding_turn_id(uuid, integer), public.qorpera_configure_coding_vm_policy(uuid, text, jsonb),
	public.qorpera_configure_coding_nas_policy(uuid, text, text, jsonb), public.qorpera_assert_coding_storage(uuid, text, jsonb, text),
	public.qorpera_authorize_coding_machine(uuid, uuid, text, text, text), public.qorpera_authorize_coding_cleanup(uuid, text, text, text),
	public.qorpera_describe_coding_cleanup(uuid, text, text), public.qorpera_authorize_coding_turn(jsonb),
	public.qorpera_begin_native_coding_execution(jsonb, text, text, text, text, text, integer), public.qorpera_record_coding_context_view(jsonb, jsonb),
	public.qorpera_submit_coding_turn(jsonb, jsonb), public.qorpera_describe_coding_turn(uuid, uuid),
	public.qorpera_authorize_coding_command(jsonb, jsonb, text, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_configure_coding_vm_policy(uuid, text, jsonb), public.qorpera_configure_coding_nas_policy(uuid, text, text, jsonb),
	public.qorpera_authorize_coding_machine(uuid, uuid, text, text, text), public.qorpera_authorize_coding_cleanup(uuid, text, text, text),
	public.qorpera_describe_coding_cleanup(uuid, text, text), public.qorpera_authorize_coding_turn(jsonb),
	public.qorpera_begin_native_coding_execution(jsonb, text, text, text, text, text, integer), public.qorpera_record_coding_context_view(jsonb, jsonb),
	public.qorpera_submit_coding_turn(jsonb, jsonb), public.qorpera_describe_coding_turn(uuid, uuid),
	public.qorpera_authorize_coding_command(jsonb, jsonb, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. The coding tools are observed under their own names
-- ---------------------------------------------------------------------------
create or replace function public.qorpera_record_runtime_observation(p_run_id uuid,p_observation jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
	v_keys text[] := array['schema','attemptId','parentAttemptId','assignmentId','phase','operation',
		'logicalOperationSha256','observedAt','durationMs','status','errorCategory','receiptId','readId',
		'inputBytes','outputBytes','inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens',
		'reasoningOutputTokens','totalTokens'];
	v_key text; v_number numeric; v_observed timestamptz;
	v_uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
	v_run public.qorpera_execution_runs%rowtype;
	v_existing public.qorpera_runtime_observations%rowtype;
	v_other public.qorpera_runtime_observations%rowtype;
	v_replayed boolean := false;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Runtime diagnostics require operator service authority' using errcode = '42501'; end if;
	if p_run_id is null or jsonb_typeof(p_observation) is distinct from 'object'
		or octet_length(p_observation::text) > 8192 or not (p_observation ?& v_keys)
		or p_observation - v_keys <> '{}'::jsonb
		or p_observation ->> 'schema' is distinct from 'qorpera.runtime-observation/v1'
		or jsonb_typeof(p_observation -> 'attemptId') is distinct from 'string'
		or p_observation ->> 'attemptId' !~* v_uuid_pattern then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['parentAttemptId','assignmentId','receiptId','readId'] loop
		if p_observation -> v_key <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> v_key) <> 'string' or p_observation ->> v_key !~* v_uuid_pattern) then
			raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	end loop;
	if p_observation ->> 'operation' not in ('model_turn','model_request','company_read','company_list',
		'company_write','company_mkdir','company_delete','send_message','read_context','send_coworker_message',
		'computer_start','computer_screen','computer_browser','computer_desktop','computer_shell','computer_screenshot',
		'computer_transfer','hire_agent','create_group_chat','manage_routine','report_work','manage_todo','manage_worker',
		'coding_run_command','coding_read_command','coding_cancel_command','coding_finish','coding_ask',
		'company_context','message_composition','connector','unknown_tool','run_authority','context_authority',
		'native_result_fence','diagnostic_export')
		or jsonb_typeof(p_observation -> 'operation') <> 'string'
		or (p_observation -> 'logicalOperationSha256' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'logicalOperationSha256') <> 'string'
			or p_observation ->> 'logicalOperationSha256' !~ '^[0-9a-f]{64}$'))
		or (p_observation -> 'errorCategory' <> 'null'::jsonb and
			(jsonb_typeof(p_observation -> 'errorCategory') <> 'string' or p_observation ->> 'errorCategory' not in (
			'invalid_arguments','unavailable_tool','call_id_reused','budget_exhausted','authority_unavailable',
			'stale_version','protected_path','ambiguous_effect','cancelled','timeout','provider_failed',
			'transport_unavailable','invalid_response','unknown','export_unavailable')))
		or not coalesce((p_observation ->> 'phase' = 'start' and p_observation ->> 'status' = 'started'
			and p_observation -> 'durationMs' = 'null'::jsonb and p_observation -> 'errorCategory' = 'null'::jsonb)
			or (p_observation ->> 'phase' = 'finish' and p_observation ->> 'status' in
			('succeeded','failed','cancelled','denied','unconfirmed','proposed','replayed')),false) then
		raise exception 'Runtime observation is invalid' using errcode = '22023'; end if;
	foreach v_key in array array['durationMs','inputBytes','outputBytes','inputTokens','outputTokens',
		'cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens','totalTokens'] loop
		if p_observation -> v_key = 'null'::jsonb then continue; end if;
		if jsonb_typeof(p_observation -> v_key) <> 'number' then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
		v_number := (p_observation ->> v_key)::numeric;
		if v_number < 0 or v_number > 9007199254740991 or v_number <> trunc(v_number) then
			raise exception 'Runtime observation counter is invalid' using errcode = '22023'; end if;
	end loop;
	-- Exactly the emitter's finite UTC-millisecond representation, not PostgreSQL
	-- special dates, local timezone guesses, calendar normalization, or year zero.
	if jsonb_typeof(p_observation -> 'observedAt') <> 'string'
		or p_observation ->> 'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
		or p_observation ->> 'observedAt' like '0000-%' then
		raise exception 'Runtime observation time is invalid' using errcode = '22023'; end if;
	begin
		v_observed := (p_observation ->> 'observedAt')::timestamptz;
		if not isfinite(v_observed) or to_char(v_observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			<> p_observation ->> 'observedAt' then raise invalid_datetime_format; end if;
	exception when datetime_field_overflow or invalid_datetime_format then
		raise exception 'Runtime observation time is invalid' using errcode = '22023';
	end;
	select * into v_run from public.qorpera_execution_runs where id = p_run_id;
	if not found then raise exception 'Runtime observation run is unavailable' using errcode = '42501'; end if;
	if (p_observation ->> 'assignmentId' is not null and not exists (
		select 1 from public.qorpera_runner_assignments a where a.id = (p_observation ->> 'assignmentId')::uuid
			and a.run_id = p_run_id and a.job_id = v_run.job_id))
		or (p_observation ->> 'receiptId' is not null and not exists (
			select 1 from public.qorpera_run_operation_receipts r where r.id = (p_observation ->> 'receiptId')::uuid
				and r.run_id = p_run_id and r.job_id = v_run.job_id))
		or (p_observation ->> 'readId' is not null and not exists (
			select 1 from public.qorpera_company_read_observations r where r.id = (p_observation ->> 'readId')::uuid
				and r.run_id = p_run_id and r.environment_id = v_run.environment_id)) then
		raise exception 'Runtime observation reference is unavailable' using errcode = '42501'; end if;
	-- Only the new diagnostic identity is locked; telemetry does not lock a
	-- job, lease, file, or live authorization. A finish may arrive before start.
	perform pg_advisory_xact_lock(hashtextextended('runtime-observation:' || p_run_id::text || ':' ||
		(p_observation ->> 'attemptId')::uuid::text,19970));
	select * into v_existing from public.qorpera_runtime_observations
	where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid and phase = p_observation ->> 'phase';
	if found then
		if v_existing.observation <> p_observation then
			raise exception 'Runtime observation identity already records different metadata' using errcode = '23505'; end if;
		v_replayed := true;
	else
		select * into v_other from public.qorpera_runtime_observations
		where run_id = p_run_id and attempt_id = (p_observation ->> 'attemptId')::uuid;
		if found and (v_other.observation -> 'operation',v_other.observation -> 'assignmentId',
			v_other.observation -> 'parentAttemptId',v_other.observation -> 'logicalOperationSha256') is distinct from
			(p_observation -> 'operation',p_observation -> 'assignmentId',p_observation -> 'parentAttemptId',
			p_observation -> 'logicalOperationSha256') then
			raise exception 'Runtime observation attempt metadata changed' using errcode = '23505'; end if;
		insert into public.qorpera_runtime_observations(run_id,attempt_id,phase,assignment_id,parent_attempt_id,
			operation,logical_operation_sha256,observed_at,observation)
		values (p_run_id,(p_observation ->> 'attemptId')::uuid,p_observation ->> 'phase',
			(p_observation ->> 'assignmentId')::uuid,(p_observation ->> 'parentAttemptId')::uuid,
			p_observation ->> 'operation',p_observation ->> 'logicalOperationSha256',v_observed,p_observation)
		returning * into v_existing;
	end if;
	return jsonb_build_object('schema','qorpera.runtime-observation-receipt/v1','runId',p_run_id,
		'attemptId',v_existing.attempt_id,'phase',v_existing.phase,'ingestedAt',v_existing.ingested_at,'replayed',v_replayed);
end
$$;
