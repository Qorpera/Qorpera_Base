-- Machines agents start themselves (Jonas, 2026-09-28: "go ahead with test
-- machines"; "a screen/instance is a computer, while the actual VM hosting
-- them is a machine").
--
-- A machine is a whole LXD virtual machine that an agent starts for a job:
-- many machines for a short time, one big machine for hours, or a small
-- machine that is always on. The agent picks its size; inside, the job is
-- root and Docker works. It belongs to the company: every member sees it and
-- may stop, wake or delete it, and any agent of the company may use it.
--
--   * Stateless (Jonas, 2026-09-28, "Stateless Compute"): nodes are
--     interchangeable and nothing a company owns lives on a node. A machine is
--     the company's record; where it runs is a disposable placement
--     (qorpera_company_machine_placements) on any node with room, and its disk
--     is scratch: kept while it sleeps where it slept, dropped when it wakes
--     where there is no room and starts fresh on another node. Results belong
--     in the company's files.
--   * Placement. The coding executor of each node carries a second workload,
--     machines, under its own policy (qorpera_machine_executors). The node
--     provider of kind 'machine' names the largest machine that node makes;
--     each placement reserves the machine's own size on the shared node ledger
--     (qorpera_company_machine_candidates is the one place a node is chosen),
--     and its disk against the disk the node's pool gives machines (asleep
--     too). When no node fits now, the machine waits until one does (the build
--     takes them in the order they asked, where they fit) and every executor
--     admits waiting machines on each pass. A size larger than any node is
--     refused at once. No price, no priority rule and no count of machines per
--     company or agent.
--   * Lifetime. A task machine sleeps after the node's idle delay (default 1 h)
--     with no command running, no agent use and a quiet processor; asleep it
--     holds no node room. One that never came up sleeps the same way. It is
--     removed after the removal delay asleep (default 30 days, like a quiet
--     coding session's archive). An always-on machine is never stopped or
--     removed by the kernel.
--   * Commands. machine_run starts a command through the executor's command
--     gateway; it has no deadline unless the agent sets one and keeps running
--     after the turn. The executor records how each command ended. A command
--     started with notify wakes its starter when it ends, and a machine that
--     finished waiting for room wakes the runs that asked for it (or tells
--     them it was stopped first), as a continuation of each run's
--     conversation (source 'machine-event'), never through model polling.
--   * No secret ever enters a machine, and none of this grants one. A coding
--     session's repository may be attached read-only (temporary: the company
--     folder replaces it; while attached, the placement is the session's node).
--
-- Nothing is enabled until an operator configures a machine executor and its
-- node provider (qorpera_configure_machine_executor,
-- qorpera_enroll_runtime_node_provider with kind 'machine'). A node gone for
-- good gives its placements up through qorpera_abandon_machine_executor.

-- ---------------------------------------------------------------------------
-- 1. Machine executors: one per node, the node's coding executor
-- ---------------------------------------------------------------------------
create table public.qorpera_machine_executors (
	owner text primary key check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	machine_id_sha256 text not null check (machine_id_sha256 ~ '^[0-9a-f]{64}$'),
	enabled boolean not null default false,
	-- providerId, providerPolicySha256, project, imageFingerprint, bootstrapSha256, storagePool, network.
	policy jsonb check (policy is null or (jsonb_typeof(policy) = 'object' and pg_column_size(policy) <= 4096)),
	-- The disk this node's pool gives machines: every placement that still exists counts its full
	-- disk size (asleep too), so one machine can never fill the pool under another company's VMs.
	disk_bytes bigint check (disk_bytes between 10737418240 and 1125899906842624),
	sleep_after_seconds integer not null default 3600 check (sleep_after_seconds between 60 and 604800),
	-- Like a coding session's archive (30 days quiet): a sleeping machine keeps its disk, tools and images.
	remove_after_seconds integer not null default 2592000 check (remove_after_seconds between 300 and 31536000),
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	check (not enabled or (policy is not null and disk_bytes is not null))
);
alter table public.qorpera_machine_executors enable row level security;
revoke all on public.qorpera_machine_executors from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Trusted deployment configuration, like the coding VM policy: the image,
-- bootstrap and network isolation are verified before these values are set.
create function public.qorpera_configure_machine_executor(p_owner text, p_machine_id_sha256 text, p_enabled boolean, p_policy jsonb,
	p_disk_bytes bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_existing public.qorpera_machine_executors%rowtype;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Machine operator authority required' using errcode = '42501'; end if;
	if coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' or p_enabled is null
		or (p_policy is not null and (jsonb_typeof(p_policy) is distinct from 'object'
			or (select count(*) from jsonb_object_keys(p_policy)) <> 7
			or p_policy - array['providerId','providerPolicySha256','project','imageFingerprint','bootstrapSha256','storagePool','network'] <> '{}'::jsonb
			or coalesce(p_policy ->> 'providerId','') !~ '^[a-z][a-z0-9_-]{0,63}$'
			or exists (select 1 from unnest(array['providerPolicySha256','imageFingerprint','bootstrapSha256']) k where coalesce(p_policy ->> k,'') !~ '^[0-9a-f]{64}$')
			or exists (select 1 from unnest(array['project','storagePool','network']) k where coalesce(p_policy ->> k,'') !~ '^[a-z][a-z0-9-]{0,62}$')))
		or (p_disk_bytes is not null and p_disk_bytes not between 10737418240 and 1125899906842624)
		or (p_enabled and (p_policy is null or p_disk_bytes is null)) then
		raise exception 'Machine executor policy invalid' using errcode = '22023'; end if;
	select * into v_existing from public.qorpera_machine_executors where owner = p_owner for update;
	-- An executor's placements live on its node's disks: it never moves to another node.
	if v_existing.owner is not null and v_existing.machine_id_sha256 <> p_machine_id_sha256 then
		raise exception 'Machine executor node is immutable' using errcode = '42501'; end if;
	insert into public.qorpera_machine_executors(owner, machine_id_sha256, enabled, policy, disk_bytes)
	values (p_owner, p_machine_id_sha256, p_enabled, p_policy, p_disk_bytes)
	on conflict (owner) do update set enabled = excluded.enabled, policy = excluded.policy, disk_bytes = excluded.disk_bytes,
		updated_at = clock_timestamp();
end
$$;

create function public.qorpera_configure_machine_lifecycle(p_owner text, p_sleep_after_seconds integer, p_remove_after_seconds integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Machine operator authority required' using errcode = '42501'; end if;
	update public.qorpera_machine_executors set sleep_after_seconds = p_sleep_after_seconds, remove_after_seconds = p_remove_after_seconds,
		updated_at = clock_timestamp()
	where owner = p_owner;
	if not found then raise exception 'Machine executor unavailable' using errcode = '42501'; end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Machines, their placements, commands and events
-- ---------------------------------------------------------------------------
create table public.qorpera_company_machines (
	id uuid primary key,
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	-- What agents and members call it; unique among the company's machines until it is removed.
	name text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
	purpose text not null check (char_length(btrim(purpose)) between 1 and 300 and purpose !~ '[\x00-\x1f]'),
	started_by_staff_agent_id uuid not null,
	started_by_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	-- The machine_start operation that created it: a replay answers with this machine.
	started_by_receipt_id uuid not null unique,
	-- The member whose computer hours it will use (PR #326: the run's requester).
	sponsor_user_id uuid not null references auth.users(id) on delete restrict,
	cpus integer not null check (cpus between 1 and 64),
	memory_bytes bigint not null check (memory_bytes between 1073741824 and 1099511627776 and memory_bytes % 1073741824 = 0),
	disk_bytes bigint not null check (disk_bytes between 10737418240 and 2199023255552 and disk_bytes % 1073741824 = 0),
	image text not null check (image = 'standard'),
	lifetime text not null check (lifetime in ('task','always-on')),
	-- A coding session whose repository folder is attached read-only (temporary, until the company folder).
	repository_worker_id uuid references public.qorpera_runtime_workers(id) on delete restrict,
	desired_state text not null default 'running' check (desired_state in ('running','stopped','deleted')),
	-- Who last asked for 'stopped' or 'deleted': an agent, a member or the kernel (idle, removal delay).
	desired_by text not null default 'agent' check (desired_by in ('agent','member','kernel')),
	-- Its place in line: when it last asked for room (a start or a wake).
	wanted_at timestamptz not null default clock_timestamp(),
	-- The runs to wake when it is running, each until it uses it.
	notify_run_ids uuid[] not null default '{}',
	-- Every use by an agent (start, wake, a command started, read or cancelled) and a busy guest: the idle clock.
	last_used_at timestamptz not null default clock_timestamp(),
	removed_at timestamptz,
	last_error text check (last_error ~ '^(start|stop|delete|release|guest|commands):[A-Z][A-Z0-9_:]{0,119}$'),
	last_error_at timestamptz,
	created_at timestamptz not null default clock_timestamp(),
	updated_at timestamptz not null default clock_timestamp(),
	check ((last_error is null) = (last_error_at is null))
);
create unique index qorpera_company_machines_name on public.qorpera_company_machines (profile_id, name) where removed_at is null;
create index qorpera_company_machines_waiting on public.qorpera_company_machines (wanted_at, id)
	where desired_state = 'running' and removed_at is null;
alter table public.qorpera_company_machines enable row level security;
revoke all on public.qorpera_company_machines from public, anon, authenticated, service_role, qorpera_secret_broker;

-- Where a machine runs: one disposable VM on one node. Its id is its capacity
-- allocation and its LXD identity. A machine has at most one current
-- placement; a retired one (the machine moved on, or was deleted) is deleted
-- by its own node's executor and released on that proof.
create table public.qorpera_company_machine_placements (
	id uuid primary key,
	machine_id uuid not null references public.qorpera_company_machines(id) on delete restrict,
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	owner text not null check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	machine_id_sha256 text not null check (machine_id_sha256 ~ '^[0-9a-f]{64}$'),
	binding jsonb not null check (jsonb_typeof(binding) = 'object' and pg_column_size(binding) <= 16384),
	instance_sha256 text not null check (instance_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	retired_at timestamptz,
	-- The executor saw the guest ready in this boot.
	running_at timestamptz,
	boot_id uuid,
	stop_authorized_at timestamptz,
	removing_at timestamptz,
	removed_at timestamptz,
	check (running_at is null or boot_id is not null),
	check (removed_at is null or removing_at is not null)
);
create unique index qorpera_company_machine_placements_current on public.qorpera_company_machine_placements (machine_id)
	where retired_at is null and removed_at is null;
create index qorpera_company_machine_placements_executor on public.qorpera_company_machine_placements (owner, machine_id_sha256)
	where removed_at is null;
alter table public.qorpera_company_machine_placements enable row level security;
revoke all on public.qorpera_company_machine_placements from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_company_machine_commands (
	-- The machine_run operation receipt: one command per receipt, exactly once.
	id uuid primary key,
	machine_id uuid not null references public.qorpera_company_machines(id) on delete restrict,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	staff_agent_id uuid not null,
	-- The placement it was started on: its log lives on that placement's disk.
	placement_id uuid not null references public.qorpera_company_machine_placements(id) on delete restrict,
	-- The command's first 300 characters, for people and the notification.
	command_head text not null check (char_length(command_head) between 1 and 300),
	notify boolean not null,
	started_at timestamptz not null default clock_timestamp(),
	-- The last time its start was sent to the guest (a retry sends it again).
	sent_at timestamptz not null default clock_timestamp(),
	ended_at timestamptz,
	-- lost: the machine stopped or restarted under it.
	state text check (state in ('succeeded','failed','cancelled','lost')),
	exit_code integer check (exit_code between 0 and 255),
	output_tail text check (octet_length(output_tail) <= 4000),
	check ((ended_at is null) = (state is null))
);
create index qorpera_company_machine_commands_open on public.qorpera_company_machine_commands (machine_id, started_at) where ended_at is null;
alter table public.qorpera_company_machine_commands enable row level security;
revoke all on public.qorpera_company_machine_commands from public, anon, authenticated, service_role, qorpera_secret_broker;

create table public.qorpera_company_machine_events (
	id uuid primary key default extensions.gen_random_uuid(),
	machine_id uuid not null references public.qorpera_company_machines(id) on delete restrict,
	profile_id uuid not null,
	environment_id uuid not null,
	staff_agent_id uuid not null,
	-- The run this continues: the one that started the machine or the command.
	parent_run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	-- running: it runs now; stopped: it was stopped or deleted before it ran; command: a command ended.
	kind text not null check (kind in ('running','stopped','command')),
	command_id uuid references public.qorpera_company_machine_commands(id) on delete restrict,
	created_at timestamptz not null default clock_timestamp(),
	delivery text not null default 'waiting' check (delivery in ('waiting','delivered','suppressed','undeliverable')),
	occurrence_id uuid,
	scanned_at timestamptz not null default '-infinity',
	check ((kind = 'command') = (command_id is not null))
);
create index qorpera_company_machine_events_waiting on public.qorpera_company_machine_events (scanned_at, created_at, id) where delivery = 'waiting';
create index qorpera_company_machine_events_occurrence on public.qorpera_company_machine_events (occurrence_id) where occurrence_id is not null;
alter table public.qorpera_company_machine_events enable row level security;
revoke all on public.qorpera_company_machine_events from public, anon, authenticated, service_role, qorpera_secret_broker;

-- ---------------------------------------------------------------------------
-- 3. The node ledger learns machines
-- ---------------------------------------------------------------------------
do $$
begin
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_runtime_machine_allocation_source'
		and conrelid = 'public.qorpera_runtime_machine_allocations'::regclass)) is distinct from
		'CHECK ((((coding_worker_id IS NULL) AND (coding_machine_id IS NULL) AND (((run_id IS NOT NULL) AND (runner_id IS NOT NULL) AND (office_id IS NULL) AND (computer_generation IS NULL) AND (login_session_id IS NULL) AND (account_refresh_request_id IS NULL) AND (login_compute_identity_id IS NULL)) OR ((run_id IS NULL) AND (runner_id IS NULL) AND (office_id IS NOT NULL) AND (computer_generation IS NOT NULL) AND (computer_generation > 0) AND (login_session_id IS NULL) AND (account_refresh_request_id IS NULL) AND (login_compute_identity_id IS NULL)) OR ((run_id IS NULL) AND (runner_id IS NULL) AND (office_id IS NULL) AND (computer_generation IS NULL) AND (num_nonnulls(login_session_id, account_refresh_request_id) = 1) AND (login_compute_identity_id IS NOT NULL)))) OR ((num_nonnulls(coding_worker_id, coding_machine_id) = 1) AND (run_id IS NULL) AND (runner_id IS NULL) AND (office_id IS NULL) AND (computer_generation IS NULL) AND (login_session_id IS NULL) AND (account_refresh_request_id IS NULL) AND (login_compute_identity_id IS NULL))))' then
		raise exception 'Machine allocation sources differ from 20260924220000';
	end if;
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_runtime_node_demands_suspension_check'
		and conrelid = 'public.qorpera_runtime_node_demands'::regclass)) is distinct from
		'CHECK (((suspended_at IS NULL) OR ((reserved_at IS NOT NULL) AND (provider_kind = ANY (ARRAY[''office''::text, ''coding''::text])))))' then
		raise exception 'Node demand suspension differs from 20260924220000';
	end if;
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_runtime_node_providers_provider_kind_check'
		and conrelid = 'public.qorpera_runtime_node_providers'::regclass)) is distinct from
		'CHECK ((provider_kind = ANY (ARRAY[''native''::text, ''office''::text, ''login''::text, ''coding''::text])))' then
		raise exception 'Node provider kinds differ from 20260922232000';
	end if;
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_runtime_node_providers_check'
		and conrelid = 'public.qorpera_runtime_node_providers'::regclass)) is distinct from
		'CHECK ((((provider_kind = ANY (ARRAY[''native''::text, ''login''::text, ''coding''::text])) AND (provider_id ~ ''^[a-z][a-z0-9_-]{0,63}$''::text)) OR ((provider_kind = ''office''::text) AND (provider_id ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''::text))))' then
		raise exception 'Node provider identities differ from 20260922232000';
	end if;
end
$$;
alter table public.qorpera_runtime_machine_allocations
	-- One allocation per placement: the placement's id is its allocation's id.
	add column company_machine_placement_id uuid unique references public.qorpera_company_machine_placements(id) on delete restrict,
	drop constraint qorpera_runtime_machine_allocation_source,
	add constraint qorpera_runtime_machine_allocation_source check(
		(coding_worker_id is null and coding_machine_id is null and company_machine_placement_id is null and (
			(run_id is not null and runner_id is not null and office_id is null and computer_generation is null
				and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
			or (run_id is null and runner_id is null and office_id is not null and computer_generation is not null and computer_generation>0
				and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
			or (run_id is null and runner_id is null and office_id is null and computer_generation is null
				and num_nonnulls(login_session_id,account_refresh_request_id)=1 and login_compute_identity_id is not null)))
		or (num_nonnulls(coding_worker_id, coding_machine_id, company_machine_placement_id) = 1 and run_id is null and runner_id is null and office_id is null
			and computer_generation is null and login_session_id is null and account_refresh_request_id is null
			and login_compute_identity_id is null)),
	add constraint qorpera_runtime_machine_allocation_company_machine check (company_machine_placement_id is null or company_machine_placement_id = id);
-- A machine provider's shape is the largest machine its node makes.
alter table public.qorpera_runtime_node_providers
	drop constraint qorpera_runtime_node_providers_provider_kind_check,
	drop constraint qorpera_runtime_node_providers_check,
	add constraint qorpera_runtime_node_providers_provider_kind_check check (provider_kind in ('native','office','login','coding','machine')),
	add constraint qorpera_runtime_node_providers_check check ((provider_kind in ('native','login','coding','machine') and provider_id ~ '^[a-z][a-z0-9_-]{0,63}$')
		or (provider_kind='office' and provider_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'));
-- An asleep machine gives its node room back, like an asleep coding machine.
alter table public.qorpera_runtime_node_demands
	drop constraint qorpera_runtime_node_demands_suspension_check,
	add constraint qorpera_runtime_node_demands_suspension_check
		check (suspended_at is null or (reserved_at is not null and provider_kind in ('office','coding','machine')));

create function pg_temp.company_machine_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Company machine integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- A machine reserves its own size, up to its provider's shape (the largest the node makes).
select pg_temp.company_machine_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$p_provider_kind not in ('native','office','login','coding')$old$,
	$new$p_provider_kind not in ('native','office','login','coding','machine')$new$);
select pg_temp.company_machine_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$  or v_provider.cpu_millis is distinct from p_cpu_millis or v_provider.memory_bytes is distinct from p_memory_bytes$old$,
	$new$  or (p_provider_kind<>'machine' and (v_provider.cpu_millis is distinct from p_cpu_millis or v_provider.memory_bytes is distinct from p_memory_bytes))
  or (p_provider_kind='machine' and (p_cpu_millis is null or p_memory_bytes is null or p_cpu_millis<1000 or p_cpu_millis>v_provider.cpu_millis
   or p_memory_bytes<1073741824 or p_memory_bytes>v_provider.memory_bytes
   or v_allocation.company_machine_placement_id is null or v_allocation.provider_adapter<>p_provider_id))$new$);
select pg_temp.company_machine_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$values(p_allocation_id,v_node.id,p_provider_kind,p_provider_id,p_policy_sha256,v_provider.cpu_millis,v_provider.memory_bytes)$old$,
	$new$values(p_allocation_id,v_node.id,p_provider_kind,p_provider_id,p_policy_sha256,
   case when p_provider_kind='machine' then p_cpu_millis else v_provider.cpu_millis end,
   case when p_provider_kind='machine' then p_memory_bytes else v_provider.memory_bytes end)$new$);
select pg_temp.company_machine_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$v_demand.cpu_millis<>v_provider.cpu_millis$old$,
	$new$v_demand.cpu_millis<>(case when p_provider_kind='machine' then p_cpu_millis else v_provider.cpu_millis end)$new$);
select pg_temp.company_machine_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$v_demand.memory_bytes<>v_provider.memory_bytes$old$,
	$new$v_demand.memory_bytes<>(case when p_provider_kind='machine' then p_memory_bytes else v_provider.memory_bytes end)$new$);
select pg_temp.company_machine_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$'cpuMillis',v_provider.cpu_millis,'memoryBytes',v_provider.memory_bytes,'validForMs',v_valid$old$,
	$new$'cpuMillis',v_demand.cpu_millis,'memoryBytes',v_demand.memory_bytes,'validForMs',v_valid$new$);

-- ---------------------------------------------------------------------------
-- 4. Views, binding and placement (internal)
-- ---------------------------------------------------------------------------
-- The end of a program's output, at most p_bytes of UTF-8, cut on a character.
create function public.qorpera_machine_text_tail(p_text text, p_bytes integer)
returns text language plpgsql immutable set search_path = '' as $$
declare v_text text := right(p_text, p_bytes);
begin
	while octet_length(v_text) > p_bytes loop
		v_text := right(v_text, char_length(v_text) - greatest(1, (octet_length(v_text) - p_bytes) / 4));
	end loop;
	return v_text;
end
$$;

-- The one canonical key order lxdCompanyMachinePlan uses: SQL hashes exactly
-- this text into the instance digest.
create function public.qorpera_company_machine_binding_text(p_binding jsonb)
returns text language sql immutable set search_path = '' as $$
	select '{' || string_agg(to_json(key)::text || ':' || (p_binding -> key)::text, ',' order by ordinal) || '}'
	from unnest(array['schema','machineId','placementId','companyId','environmentId','providerId','providerPolicySha256','project',
		'imageFingerprint','bootstrapSha256','storagePool','network','cpus','memoryBytes','rootDiskBytes','repositoryWorkerId'])
		with ordinality as keys(key, ordinal)
$$;

-- The machine's current placement, if any.
create function public.qorpera_company_machine_placement(p_machine_id uuid)
returns public.qorpera_company_machine_placements language sql stable security definer set search_path = '' as $$
	select placement from public.qorpera_company_machine_placements placement
	where placement.machine_id = p_machine_id and placement.retired_at is null and placement.removed_at is null
$$;

-- A placement's live node demand: reserved and awake.
create function public.qorpera_company_machine_placement_reserved(p_placement_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_runtime_node_demands demand
		join public.qorpera_runtime_machine_allocations allocation on allocation.id = demand.allocation_id
		where demand.allocation_id = p_placement_id and demand.provider_kind = 'machine' and demand.reserved_at is not null
			and demand.suspended_at is null and demand.released_at is null and allocation.released_at is null)
$$;

-- The machine holds room now: its current placement is reserved and awake.
create function public.qorpera_company_machine_reserved(p_machine public.qorpera_company_machines)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce(public.qorpera_company_machine_placement_reserved((public.qorpera_company_machine_placement(p_machine.id)).id), false)
$$;

create function public.qorpera_company_machine_state(p_machine public.qorpera_company_machines)
returns text language sql stable security definer set search_path = '' as $$
	select case when p_machine.removed_at is not null then 'deleted'
		when p_machine.desired_state = 'deleted' then 'deleting'
		when p_machine.desired_state = 'running' then
			case when not public.qorpera_company_machine_reserved(p_machine) then 'waiting'
				when (public.qorpera_company_machine_placement(p_machine.id)).running_at is null then 'starting' else 'running' end
		when public.qorpera_company_machine_reserved(p_machine) then 'stopping'
		else 'stopped' end
$$;

-- What agents and members see of a machine. Never its binding or node identity.
create function public.qorpera_company_machine_view(p_machine public.qorpera_company_machines)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_state text := public.qorpera_company_machine_state(p_machine);
	v_placement public.qorpera_company_machine_placements%rowtype := public.qorpera_company_machine_placement(p_machine.id);
	v_refusal text; v_node text;
begin
	select demand.last_refusal, node.label into v_refusal, v_node from public.qorpera_runtime_node_demands demand
	join public.qorpera_runtime_nodes node on node.id = demand.node_id where demand.allocation_id = v_placement.id;
	return jsonb_build_object('machineId', p_machine.id, 'name', p_machine.name, 'purpose', p_machine.purpose, 'state', v_state,
		'cpus', p_machine.cpus, 'memoryGiB', p_machine.memory_bytes / 1073741824, 'diskGiB', p_machine.disk_bytes / 1073741824,
		'image', p_machine.image, 'lifetime', p_machine.lifetime,
		'repository', (select jsonb_build_object('workerKey', worker.worker_key, 'title', worker.title)
			from public.qorpera_runtime_workers worker where worker.id = p_machine.repository_worker_id),
		'startedBy', jsonb_build_object('staffAgentId', p_machine.started_by_staff_agent_id, 'runId', p_machine.started_by_run_id,
			'name', (select staff.display_name from public.qorpera_profile_staff staff
				where staff.profile_id = p_machine.profile_id and staff.staff_agent_id = p_machine.started_by_staff_agent_id)),
		'sponsorUserId', p_machine.sponsor_user_id, 'node', v_node,
		'queuePosition', case when v_state = 'waiting' then (select count(*) + 1 from public.qorpera_company_machines other
			where other.desired_state = 'running' and other.removed_at is null and (other.wanted_at, other.id) < (p_machine.wanted_at, p_machine.id)
				and not public.qorpera_company_machine_reserved(other)) end,
		'waitingFor', case when v_state = 'waiting' then coalesce(v_refusal, 'NODE_CAPACITY_EXHAUSTED') end,
		'runningSince', v_placement.running_at, 'stoppedBy', case when p_machine.desired_state <> 'running' then p_machine.desired_by end,
		'commandsRunning', (select count(*) from public.qorpera_company_machine_commands command
			where command.machine_id = p_machine.id and command.ended_at is null),
		'lastError', p_machine.last_error, 'createdAt', p_machine.created_at, 'updatedAt', p_machine.updated_at);
end
$$;

-- The disk an executor's node has promised to machines: every placement that
-- still exists there, asleep or retired, at its full size; but for the one
-- machine being placed, whose own old placement its move gives up.
create function public.qorpera_machine_executor_disk_used(p_owner text, p_except_machine_id uuid default null)
returns bigint language sql stable security definer set search_path = '' as $$
	select coalesce(sum(machine.disk_bytes), 0)::bigint from public.qorpera_company_machine_placements placement
	join public.qorpera_company_machines machine on machine.id = placement.machine_id
	where placement.owner = p_owner and placement.removed_at is null and placement.machine_id is distinct from p_except_machine_id
$$;

-- The executors a machine of this size may go to, the one with the most room
-- first. The one place a node is chosen for a machine; a read only, the
-- reservation that follows decides.
create function public.qorpera_company_machine_candidates(p_cpu_millis bigint, p_memory_bytes bigint, p_disk_bytes bigint,
	p_owner text default null, p_machine_id uuid default null)
returns table(owner text, machine_id_sha256 text, policy jsonb) language sql stable security definer set search_path = '' as $$
	select executor.owner, executor.machine_id_sha256, executor.policy
	from public.qorpera_machine_executors executor
	join public.qorpera_runtime_node_providers provider on provider.provider_kind = 'machine'
		and provider.provider_id = executor.policy ->> 'providerId' and provider.policy_sha256 = executor.policy ->> 'providerPolicySha256'
	join public.qorpera_runtime_nodes node on node.id = provider.node_id and node.machine_id_sha256 = executor.machine_id_sha256
	join public.qorpera_runtime_node_observations observation on observation.node_id = node.id
	cross join lateral (select coalesce(sum(d.cpu_millis), 0) as cpu, coalesce(sum(d.memory_bytes), 0) as memory
		from public.qorpera_runtime_node_demands d where d.node_id = node.id and d.reserved_at is not null
			and d.released_at is null and d.suspended_at is null) used
	where executor.enabled and executor.policy is not null and (p_owner is null or executor.owner = p_owner)
		and provider.cpu_millis >= p_cpu_millis and provider.memory_bytes >= p_memory_bytes
		and node.enabled and observation.observed_at > clock_timestamp() - interval '60 seconds'
		and observation.observed_at <= clock_timestamp() + interval '2 seconds' and observation.observation ->> 'state' = 'ready'
		and public.qorpera_runtime_node_inventory_ready(node.id, observation.observation_id, node.version)
		and used.cpu + p_cpu_millis <= public.qorpera_runtime_node_cpu_budget(node)
		and used.memory + p_memory_bytes <= node.memory_bytes - node.headroom_memory_bytes
		and public.qorpera_machine_executor_disk_used(executor.owner, p_machine_id) + p_disk_bytes <= executor.disk_bytes
	order by node.memory_bytes - node.headroom_memory_bytes - used.memory desc,
		public.qorpera_runtime_node_cpu_budget(node) - used.cpu desc, node.id, executor.owner
$$;

-- A new placement of a machine on one executor's node: its binding, its
-- allocation and a node reservation, all or nothing. A refused reservation
-- leaves nothing behind. The executor row is held while its disk is counted
-- again, so two placements never share the same free disk. Internal: the
-- caller holds the machine row and has retired any earlier placement it replaces.
create function public.qorpera_place_company_machine(p_machine_id uuid, p_owner text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype; v_executor public.qorpera_machine_executors%rowtype;
	v_placement uuid := extensions.gen_random_uuid(); v_binding jsonb; v_text text; v_digest text; v_node jsonb;
begin
	select * into strict v_machine from public.qorpera_company_machines where id = p_machine_id;
	if v_machine.removed_at is not null or v_machine.desired_state <> 'running'
		or (public.qorpera_company_machine_placement(v_machine.id)).id is not null then
		return '{"state":"refused","reason":"MACHINE_NOT_WAITING"}'::jsonb; end if;
	select * into v_executor from public.qorpera_machine_executors where owner = p_owner and enabled and policy is not null for update;
	if v_executor.owner is null then return '{"state":"refused","reason":"MACHINES_UNAVAILABLE"}'::jsonb; end if;
	if public.qorpera_machine_executor_disk_used(v_executor.owner, v_machine.id) + v_machine.disk_bytes > v_executor.disk_bytes then
		return '{"state":"refused","reason":"NODE_DISK_EXHAUSTED"}'::jsonb; end if;
	-- A repository lives on the NAS of the node that holds its coding session (until the company folder).
	if v_machine.repository_worker_id is not null and not exists (select 1 from public.qorpera_coding_storage_volumes volume
		where volume.worker_id = v_machine.repository_worker_id and volume.owner = v_executor.owner
			and volume.machine_id_sha256 = v_executor.machine_id_sha256) then
		return '{"state":"refused","reason":"REPOSITORY_ON_ANOTHER_NODE"}'::jsonb; end if;
	v_binding := jsonb_build_object('schema','qorpera.lxd-company-machine/v1','machineId',v_machine.id,'placementId',v_placement,
		'companyId',v_machine.profile_id,'environmentId',v_machine.environment_id) || v_executor.policy
		|| jsonb_build_object('cpus',v_machine.cpus,'memoryBytes',v_machine.memory_bytes,'rootDiskBytes',v_machine.disk_bytes,
			'repositoryWorkerId',v_machine.repository_worker_id);
	v_text := public.qorpera_company_machine_binding_text(v_binding);
	v_digest := encode(extensions.digest(convert_to(v_text,'utf8'),'sha256'),'hex');
	begin
		-- Lock order as in reservation: profile fence -> company allocation -> node -> demand.
		perform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);
		insert into public.qorpera_company_machine_placements(id, machine_id, profile_id, owner, machine_id_sha256, binding, instance_sha256)
		values (v_placement, v_machine.id, v_machine.profile_id, v_executor.owner, v_executor.machine_id_sha256, v_binding, v_digest);
		insert into public.qorpera_runtime_machine_allocations(id, profile_id, company_machine_placement_id, provider_adapter, instance_sha256)
		values (v_placement, v_machine.profile_id, v_placement, v_binding ->> 'providerId', v_digest);
		v_node := public.qorpera_reserve_runtime_node_machine(v_placement, 'machine', v_binding ->> 'providerId',
			v_binding ->> 'providerPolicySha256', v_digest, v_executor.machine_id_sha256, v_machine.cpus::bigint * 1000, v_machine.memory_bytes);
		if v_node ->> 'state' <> 'reserved' then raise sqlstate 'P0F02'; end if;
	exception when sqlstate 'P0F02' then return v_node;
		-- A node whose ledger refuses this provider or identity is not a place for it now.
		when insufficient_privilege then return '{"state":"refused","reason":"NODE_UNAVAILABLE"}'::jsonb;
	end;
	return v_node || jsonb_build_object('placementId', v_placement);
end
$$;

-- One attempt to give a machine that wants to run its room now. Its current
-- placement asks its own node first (a wake keeps the scratch disk it slept
-- with). Refused there, a machine that is not running moves on: it is placed
-- fresh on the best node that fits (or on p_owner's only), and the old
-- placement is retired for its executor to delete. A placement made under a
-- machine policy its node no longer uses (a new image) is never woken: the
-- machine starts fresh, on the same node too. A machine with no placement is
-- placed. Room given now restarts its idle clock. Every refused attempt is
-- rolled back with its locks, so a caller holds at most the one node it got.
-- Internal: the caller holds the machine row.
create function public.qorpera_admit_company_machine(p_machine_id uuid, p_owner text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype; v_placement public.qorpera_company_machine_placements%rowtype;
	v_candidate record; v_result jsonb; v_own jsonb; v_largest record; v_executor public.qorpera_machine_executors%rowtype;
	v_stale boolean := false;
begin
	select * into strict v_machine from public.qorpera_company_machines where id = p_machine_id;
	if v_machine.removed_at is not null or v_machine.desired_state <> 'running' then return '{"state":"refused","reason":"MACHINE_NOT_WAITING"}'::jsonb; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_placement.id is not null and public.qorpera_company_machine_placement_reserved(v_placement.id) then return '{"state":"reserved"}'::jsonb; end if;
	if public.qorpera_company_execution_paused(v_machine.profile_id) then return '{"state":"refused","reason":"COMPANY_PAUSED"}'::jsonb; end if;
	if v_placement.id is not null then
		select * into v_executor from public.qorpera_machine_executors where owner = v_placement.owner;
		v_stale := v_executor.policy is null or not (v_placement.binding @> v_executor.policy);
		if v_stale then v_own := '{"state":"refused","reason":"MACHINE_POLICY_CHANGED"}'::jsonb;
		elsif not coalesce(v_executor.enabled, false) then v_own := '{"state":"refused","reason":"NODE_DISABLED"}'::jsonb;
		else
			begin
				v_own := public.qorpera_reserve_runtime_node_machine(v_placement.id, 'machine', v_placement.binding ->> 'providerId',
					v_placement.binding ->> 'providerPolicySha256', v_placement.instance_sha256, v_placement.machine_id_sha256,
					v_machine.cpus::bigint * 1000, v_machine.memory_bytes);
				if v_own ->> 'state' = 'reserved' then
					update public.qorpera_company_machines set last_used_at = clock_timestamp() where id = v_machine.id;
					return v_own;
				end if;
				raise sqlstate 'P0F02';
			exception when sqlstate 'P0F02' then null;
				when insufficient_privilege then v_own := '{"state":"refused","reason":"NODE_UNAVAILABLE"}'::jsonb;
			end;
		end if;
		-- Moving drops the scratch disk: only for a machine that is not running, never away from its
		-- repository's node, and not while its node may only be looking away (a node without a usable
		-- observation keeps a machine that asked for room less than five minutes ago).
		if v_placement.running_at is not null or (v_machine.repository_worker_id is not null and not v_stale)
			or (v_own ->> 'reason' = 'NODE_OBSERVATION_UNAVAILABLE' and v_machine.wanted_at > clock_timestamp() - interval '5 minutes') then
			return v_own; end if;
	end if;
	v_result := coalesce(v_own, '{"state":"refused","reason":"NODE_CAPACITY_EXHAUSTED"}'::jsonb);
	for v_candidate in select * from public.qorpera_company_machine_candidates(v_machine.cpus::bigint * 1000, v_machine.memory_bytes,
		v_machine.disk_bytes, p_owner, v_machine.id) loop
		begin
			if v_placement.id is not null then
				update public.qorpera_company_machine_placements set retired_at = clock_timestamp() where id = v_placement.id;
			end if;
			v_result := public.qorpera_place_company_machine(v_machine.id, v_candidate.owner);
			if v_result ->> 'state' <> 'reserved' then raise sqlstate 'P0F03'; end if;
			update public.qorpera_company_machines set last_used_at = clock_timestamp() where id = v_machine.id;
			return v_result;
		exception when sqlstate 'P0F03' then null;
		end;
	end loop;
	if v_placement.id is not null then return v_result; end if;
	-- Nothing fits now. Say why when it never will: no node (the repository's, when one is attached)
	-- makes a machine this large or gives machines this much disk.
	select max(provider.cpu_millis) as cpu_millis, max(provider.memory_bytes) as memory_bytes, max(executor.disk_bytes) as disk_bytes
		into v_largest
	from public.qorpera_machine_executors executor
	join public.qorpera_runtime_node_providers provider on provider.provider_kind = 'machine'
		and provider.provider_id = executor.policy ->> 'providerId' and provider.policy_sha256 = executor.policy ->> 'providerPolicySha256'
	where executor.enabled and executor.policy is not null and (p_owner is null or executor.owner = p_owner);
	if v_largest.cpu_millis is null then return '{"state":"refused","reason":"MACHINES_UNAVAILABLE"}'::jsonb; end if;
	if not exists (select 1 from public.qorpera_machine_executors executor
		join public.qorpera_runtime_node_providers provider on provider.provider_kind = 'machine'
			and provider.provider_id = executor.policy ->> 'providerId' and provider.policy_sha256 = executor.policy ->> 'providerPolicySha256'
		where executor.enabled and executor.policy is not null and (p_owner is null or executor.owner = p_owner)
			and provider.cpu_millis >= v_machine.cpus::bigint * 1000 and provider.memory_bytes >= v_machine.memory_bytes
			and executor.disk_bytes >= v_machine.disk_bytes
			and (v_machine.repository_worker_id is null or exists (select 1 from public.qorpera_coding_storage_volumes volume
				where volume.worker_id = v_machine.repository_worker_id and volume.owner = executor.owner
					and volume.machine_id_sha256 = executor.machine_id_sha256))) then
		return jsonb_build_object('state','refused','reason','MACHINE_TOO_LARGE','largest',
			jsonb_build_object('cpus', v_largest.cpu_millis / 1000, 'memoryGiB', v_largest.memory_bytes / 1073741824,
				'diskGiB', v_largest.disk_bytes / 1073741824)); end if;
	return v_result;
end
$$;

-- Ends every open command of a machine that stopped, restarted or moved, and
-- queues the notifications they asked for; or, observed, the ones the guest
-- saw end. A command the guest does not know yet may still be on its way
-- there: it is lost only two minutes after its start was last sent. Internal:
-- the caller holds the machine row.
create function public.qorpera_end_company_machine_commands(p_machine public.qorpera_company_machines, p_state text,
	p_ended jsonb default '[]'::jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_command public.qorpera_company_machine_commands%rowtype; v_item jsonb; v_count integer := 0;
begin
	for v_command in select * from public.qorpera_company_machine_commands where machine_id = p_machine.id and ended_at is null
		order by started_at, id for update loop
		select item into v_item from jsonb_array_elements(p_ended) item where item ->> 'commandId' = v_command.id::text;
		if p_state = 'observed' and (v_item is null
			or (v_item ->> 'state' = 'lost' and v_command.sent_at > clock_timestamp() - interval '2 minutes')) then continue; end if;
		update public.qorpera_company_machine_commands set ended_at = clock_timestamp(),
			state = case when p_state = 'observed' then v_item ->> 'state' else p_state end,
			exit_code = case when p_state = 'observed' and v_item ->> 'state' in ('succeeded','failed') then (v_item ->> 'exitCode')::integer end,
			output_tail = case when p_state = 'observed' then public.qorpera_machine_text_tail(v_item ->> 'outputTail', 4000) end
		where id = v_command.id;
		if v_command.notify then
			insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind, command_id)
			values (p_machine.id, p_machine.profile_id, p_machine.environment_id, v_command.staff_agent_id, v_command.run_id, 'command', v_command.id);
		end if;
		v_count := v_count + 1;
	end loop;
	return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Agent tools
-- ---------------------------------------------------------------------------
-- The company's machine an agent names, locked. Internal. A refusal the
-- agent can act on is raised as P0F10 'CODE: text' and answered as a result.
create function public.qorpera_company_machine_named(p_profile_id uuid, p_name text)
returns public.qorpera_company_machines language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype;
begin
	select * into v_machine from public.qorpera_company_machines where profile_id = p_profile_id and name = p_name and removed_at is null for update;
	if v_machine.id is null then raise exception 'MACHINE_NOT_FOUND: no machine is named %', p_name using errcode = 'P0F10'; end if;
	return v_machine;
end
$$;

-- machine_start, receipted like computer_start: 'authorize' checks the exact
-- input against current authority; 'begin' records the machine against the
-- executing receipt (a replay answers with the same machine) and gives it
-- room now or a place in line. arguments: a new machine {name, purpose, cpus,
-- memoryGiB, diskGiB, lifetime, repositoryWorker?}, or {machine} to wake one.
create function public.qorpera_native_machine_start(p_binding jsonb, p_envelope text, p_action text, p_receipt_id uuid default null,
	p_idempotency_sha256 text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_authority jsonb; v_identity jsonb; v_envelope jsonb; v_operation jsonb; v_args jsonb; v_sha text;
	v_receipt public.qorpera_run_operation_receipts%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_worker public.qorpera_runtime_workers%rowtype; v_admission jsonb; v_keys text;
begin
	if auth.role() is distinct from 'service_role' or p_action is null or p_action not in ('authorize','begin')
		or p_envelope is null or octet_length(p_envelope) > 16384 then
		raise exception 'Invalid machine start' using errcode = '42501'; end if;
	v_authority := public.qorpera_describe_native_tool_authority(p_binding);
	v_identity := v_authority -> 'identity';
	-- Machines are the company's: only a run in a company conversation starts or uses them.
	if v_identity ->> 'audienceKind' is distinct from 'company' then
		raise exception 'Machines belong to company conversations' using errcode = '42501'; end if;
	perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid);
	v_envelope := p_envelope::jsonb;
	v_operation := v_envelope -> 'operation';
	v_args := v_operation -> 'arguments';
	v_keys := (select string_agg(key, ',' order by key collate "C") from jsonb_object_keys(case when jsonb_typeof(v_args) = 'object' then v_args else '{}' end) key);
	if jsonb_typeof(v_envelope) is distinct from 'object' or v_envelope - 'schema' - 'principals' - 'operation' <> '{}'::jsonb
		or v_envelope ->> 'schema' is distinct from 'qorpera.cloud-tool-operation/v2'
		or v_envelope -> 'principals' is distinct from v_identity - array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion']
		or jsonb_typeof(v_operation) is distinct from 'object'
		or v_operation - array['tool','toolVersion','logicalOperationKey','arguments','target','requiresCompanyRevision'] <> '{}'::jsonb
		or v_operation ->> 'tool' is distinct from 'machine_start'
		or v_operation ->> 'toolVersion' is distinct from 'qorpera.machine-tools/v1'
		or v_operation -> 'requiresCompanyRevision' is distinct from 'false'::jsonb
		or coalesce(v_operation ->> 'logicalOperationKey','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'
		or v_operation -> 'target' is distinct from '{"realm":"company_machine"}'::jsonb
		or jsonb_typeof(v_args) is distinct from 'object'
		or (v_keys is distinct from 'machine' and v_keys is distinct from 'cpus,diskGiB,lifetime,memoryGiB,name,purpose'
			and v_keys is distinct from 'cpus,diskGiB,lifetime,memoryGiB,name,purpose,repositoryWorker')
		or (v_args ? 'machine' and coalesce(v_args ->> 'machine','') !~ '^[a-z0-9][a-z0-9-]{0,39}$')
		or (v_args ? 'name' and (coalesce(v_args ->> 'name','') !~ '^[a-z0-9][a-z0-9-]{0,39}$'
			or jsonb_typeof(v_args -> 'purpose') is distinct from 'string' or char_length(btrim(v_args ->> 'purpose')) not between 1 and 300
			or v_args ->> 'purpose' ~ '[\x00-\x1f]'
			or jsonb_typeof(v_args -> 'cpus') is distinct from 'number' or v_args ->> 'cpus' !~ '^[1-9][0-9]?$' or (v_args ->> 'cpus')::integer > 64
			or jsonb_typeof(v_args -> 'memoryGiB') is distinct from 'number' or v_args ->> 'memoryGiB' !~ '^[1-9][0-9]{0,3}$' or (v_args ->> 'memoryGiB')::integer > 1024
			or jsonb_typeof(v_args -> 'diskGiB') is distinct from 'number' or v_args ->> 'diskGiB' !~ '^[1-9][0-9]{1,3}$' or (v_args ->> 'diskGiB')::integer > 2048
			or v_args ->> 'lifetime' not in ('task','always-on')
			or (v_args ? 'repositoryWorker' and coalesce(v_args ->> 'repositoryWorker','') !~ '^[a-z0-9][a-z0-9._-]{0,79}$'))) then
		raise exception 'Machine start differs from current authority' using errcode = '42501'; end if;
	if p_action = 'authorize' then
		if p_receipt_id is not null or p_idempotency_sha256 is not null then raise exception 'Unexpected machine receipt' using errcode = '22023'; end if;
		return '{"state":"authorized"}'::jsonb;
	end if;
	v_sha := encode(extensions.digest(convert_to(p_envelope,'UTF8'),'sha256'),'hex');
	select * into v_receipt from public.qorpera_run_operation_receipts where id = p_receipt_id for update;
	if not found or v_receipt.run_id::text is distinct from p_binding ->> 'runId' or v_receipt.status <> 'executing'
		or v_receipt.operation_kind <> 'cloud_tool' or v_receipt.input_sha256 <> v_sha
		or coalesce(p_idempotency_sha256,'') !~ '^[0-9a-f]{64}$'
		or v_receipt.downstream_idempotency_sha256 is distinct from p_idempotency_sha256
		or v_receipt.logical_operation_key is distinct from 'machine_start:' || (v_operation ->> 'logicalOperationKey')
		or v_receipt.requires_company_revision then
		raise exception 'Machine start receipt differs' using errcode = '42501'; end if;
	-- One company's machines are started and woken one at a time.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || (v_identity ->> 'companyId'), 0));
	-- A refusal the agent can act on is its result, and leaves no machine behind.
	begin
	select * into v_machine from public.qorpera_company_machines where started_by_receipt_id = v_receipt.id for update;
	if v_machine.id is null and v_args ? 'machine' then
		v_machine := public.qorpera_company_machine_named((v_identity ->> 'companyId')::uuid, v_args ->> 'machine');
		if v_machine.desired_state = 'deleted' then raise exception 'MACHINE_DELETING: % is being deleted', v_machine.name using errcode = 'P0F10'; end if;
		if v_machine.desired_state <> 'running' then
			update public.qorpera_company_machines set desired_state = 'running', desired_by = 'agent', wanted_at = clock_timestamp(),
				updated_at = clock_timestamp()
			where id = v_machine.id;
			update public.qorpera_company_machine_placements set stop_authorized_at = null
			where id = (public.qorpera_company_machine_placement(v_machine.id)).id;
		end if;
		-- Every run that woke it is told when it runs, each until it uses it.
		update public.qorpera_company_machines set
			notify_run_ids = case when (public.qorpera_company_machine_placement(id)).running_at is null
				and not v_receipt.run_id = any(notify_run_ids) then notify_run_ids || v_receipt.run_id else notify_run_ids end,
			last_used_at = clock_timestamp() where id = v_machine.id returning * into v_machine;
	elsif v_machine.id is null then
		if exists (select 1 from public.qorpera_company_machines where profile_id = (v_identity ->> 'companyId')::uuid
			and name = v_args ->> 'name' and removed_at is null) then
			raise exception 'MACHINE_NAME_TAKEN: the company already has a machine named %', v_args ->> 'name' using errcode = 'P0F10'; end if;
		if v_args ? 'repositoryWorker' then
			select * into v_worker from public.qorpera_runtime_workers where profile_id = (v_identity ->> 'companyId')::uuid
				and environment_id = (v_identity ->> 'environmentId')::uuid and worker_key = v_args ->> 'repositoryWorker' and species = 'coding'
			order by created_at desc limit 1;
			if v_worker.id is null or not exists (select 1 from public.qorpera_coding_storage_volumes where worker_id = v_worker.id) then
				raise exception 'REPOSITORY_UNAVAILABLE: no coding session % with a repository', v_args ->> 'repositoryWorker' using errcode = 'P0F10'; end if;
		end if;
		insert into public.qorpera_company_machines(id, profile_id, environment_id, name, purpose, started_by_staff_agent_id, started_by_run_id,
			started_by_receipt_id, sponsor_user_id, cpus, memory_bytes, disk_bytes, image, lifetime, repository_worker_id, notify_run_ids)
		values (extensions.gen_random_uuid(), (v_identity ->> 'companyId')::uuid, (v_identity ->> 'environmentId')::uuid, v_args ->> 'name',
			btrim(v_args ->> 'purpose'), (v_identity ->> 'staffAgentId')::uuid, v_receipt.run_id, v_receipt.id, (v_identity ->> 'requesterUserId')::uuid,
			(v_args ->> 'cpus')::integer, (v_args ->> 'memoryGiB')::bigint * 1073741824, (v_args ->> 'diskGiB')::bigint * 1073741824,
			'standard', v_args ->> 'lifetime', v_worker.id, array[v_receipt.run_id])
		returning * into v_machine;
	end if;
	v_admission := public.qorpera_admit_company_machine(v_machine.id);
	-- Never room anywhere: refused at once (the new machine is not kept).
	if v_admission ->> 'reason' = 'MACHINE_TOO_LARGE' then
		raise exception 'MACHINE_TOO_LARGE: the largest machine a node makes is % CPUs, % GiB memory and % GiB disk',
			v_admission #>> '{largest,cpus}', v_admission #>> '{largest,memoryGiB}', v_admission #>> '{largest,diskGiB}' using errcode = 'P0F10'; end if;
	if v_admission ->> 'reason' = 'MACHINES_UNAVAILABLE' then
		raise exception 'MACHINES_UNAVAILABLE: no node runs machines yet' using errcode = 'P0F10'; end if;
	exception when sqlstate 'P0F10' then
		return jsonb_build_object('schema','qorpera.machine-start/v1','refused',jsonb_build_object('reason',split_part(sqlerrm,':',1),
			'message',btrim(substring(sqlerrm from position(':' in sqlerrm) + 1))));
	end;
	select * into strict v_machine from public.qorpera_company_machines where id = v_machine.id;
	perform public.qorpera_describe_native_tool_authority(p_binding);
	return jsonb_build_object('schema','qorpera.machine-start/v1','machine',public.qorpera_company_machine_view(v_machine));
end
$$;

-- machine_list, machine_stop and machine_delete. Stopping and deleting are
-- idempotent desired states the machine's executor carries out; nothing here
-- touches a node.
create function public.qorpera_native_machine_manage(p_binding jsonb, p_request jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity jsonb; v_machine public.qorpera_company_machines%rowtype; v_action text := p_request ->> 'action';
begin
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_request) is distinct from 'object'
		or v_action is null or v_action not in ('list','stop','delete')
		or (v_action = 'list' and p_request - 'action' <> '{}'::jsonb)
		or (v_action <> 'list' and (p_request - array['action','machine'] <> '{}'::jsonb
			or coalesce(p_request ->> 'machine','') !~ '^[a-z0-9][a-z0-9-]{0,39}$')) then
		raise exception 'Invalid machine request' using errcode = '22023'; end if;
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	-- Machines are the company's: only a run in a company conversation starts or uses them.
	if v_identity ->> 'audienceKind' is distinct from 'company' then
		raise exception 'Machines belong to company conversations' using errcode = '42501'; end if;
	if v_action = 'list' then
		return jsonb_build_object('schema','qorpera.machine-list/v1','machines',coalesce((select jsonb_agg(public.qorpera_company_machine_view(machine)
			order by machine.created_at, machine.id) from public.qorpera_company_machines machine
			where machine.profile_id = (v_identity ->> 'companyId')::uuid and machine.removed_at is null), '[]'::jsonb));
	end if;
	perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid);
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || (v_identity ->> 'companyId'), 0));
	begin
		v_machine := public.qorpera_company_machine_named((v_identity ->> 'companyId')::uuid, p_request ->> 'machine');
	exception when sqlstate 'P0F10' then
		return jsonb_build_object('schema','qorpera.machine-change/v1','refused',jsonb_build_object('reason',split_part(sqlerrm,':',1),
			'message',btrim(substring(sqlerrm from position(':' in sqlerrm) + 1))));
	end;
	-- The run that stops or deletes it knows already: it is not woken to be told.
	update public.qorpera_company_machines set notify_run_ids = array_remove(notify_run_ids, (p_binding ->> 'runId')::uuid)
	where id = v_machine.id returning * into v_machine;
	v_machine := public.qorpera_set_company_machine_desired(v_machine, case when v_action = 'stop' then 'stopped' else 'deleted' end, 'agent');
	return jsonb_build_object('schema','qorpera.machine-change/v1','machine',public.qorpera_company_machine_view(v_machine));
end
$$;

-- Stop or delete: the executors do the rest. A machine with nothing left on
-- any node is removed here at once, and the runs waiting for it to run hear
-- that it will not. Internal: the caller holds the machine row.
create function public.qorpera_set_company_machine_desired(p_machine public.qorpera_company_machines, p_desired text, p_by text)
returns public.qorpera_company_machines language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype := p_machine;
begin
	if p_desired not in ('stopped','deleted') or p_by not in ('agent','member','kernel') then
		raise exception 'Invalid machine change' using errcode = '22023'; end if;
	if v_machine.removed_at is not null or v_machine.desired_state = 'deleted' or v_machine.desired_state = p_desired then return v_machine; end if;
	-- The runs still waiting for it to run are told it will not.
	insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind)
	select v_machine.id, v_machine.profile_id, v_machine.environment_id, run.staff_agent_id, run.id, 'stopped'
	from public.qorpera_execution_runs run where run.id = any(v_machine.notify_run_ids) order by run.id;
	update public.qorpera_company_machines set desired_state = p_desired, desired_by = p_by, notify_run_ids = '{}', updated_at = clock_timestamp()
	where id = v_machine.id returning * into v_machine;
	if p_desired = 'deleted' then
		update public.qorpera_company_machine_placements set retired_at = coalesce(retired_at, clock_timestamp())
		where machine_id = v_machine.id and removed_at is null;
		v_machine := public.qorpera_close_company_machine(v_machine);
	end if;
	return v_machine;
end
$$;

-- A deleted machine is removed once none of its placements is left on a node.
-- Internal: the caller holds the machine row.
create function public.qorpera_close_company_machine(p_machine public.qorpera_company_machines)
returns public.qorpera_company_machines language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype := p_machine;
begin
	if v_machine.desired_state = 'deleted' and v_machine.removed_at is null and not exists (select 1
		from public.qorpera_company_machine_placements where machine_id = v_machine.id and removed_at is null) then
		perform public.qorpera_end_company_machine_commands(v_machine, 'lost');
		update public.qorpera_company_machines set removed_at = clock_timestamp(), notify_run_ids = '{}', last_error = null, last_error_at = null,
			updated_at = clock_timestamp()
		where id = v_machine.id returning * into v_machine;
	end if;
	return v_machine;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Command authority (the executor's command gateway)
-- ---------------------------------------------------------------------------
-- A command on a machine: the calling run's live tool authority, a company
-- machine that is running, and for a start the run's own executing
-- machine_run receipt (its id is the command id, its input digest binds the
-- command). Reading and cancelling reach any command of the machine, whoever
-- started it: the machine is the company's. Returns where it runs now.
create function public.qorpera_authorize_machine_command(p_binding jsonb, p_scope jsonb, p_action text, p_command_id uuid,
	p_input_sha256 text default null, p_detail jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity jsonb; v_machine public.qorpera_company_machines%rowtype; v_receipt public.qorpera_run_operation_receipts%rowtype;
	v_command public.qorpera_company_machine_commands%rowtype; v_machine_id uuid; v_placement public.qorpera_company_machine_placements%rowtype;
begin
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_scope) is distinct from 'object' or p_scope - 'machineId' <> '{}'::jsonb
		or p_action is null or p_action not in ('start','read','cancel') or p_command_id is null
		or ((p_action = 'start') <> (p_detail is not null)) or ((p_action = 'start') <> (p_input_sha256 is not null))
		or (p_detail is not null and (jsonb_typeof(p_detail) is distinct from 'object' or p_detail - array['commandHead','notify'] <> '{}'::jsonb
			or jsonb_typeof(p_detail -> 'commandHead') is distinct from 'string' or char_length(p_detail ->> 'commandHead') not between 1 and 300
			or jsonb_typeof(p_detail -> 'notify') is distinct from 'boolean')) then
		raise exception 'Machine command scope invalid' using errcode = '22023'; end if;
	begin v_machine_id := (p_scope ->> 'machineId')::uuid;
	exception when invalid_text_representation then raise exception 'Machine command scope invalid' using errcode = '22023'; end;
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	-- Machines are the company's: only a run in a company conversation starts or uses them.
	if v_identity ->> 'audienceKind' is distinct from 'company' then
		raise exception 'Machines belong to company conversations' using errcode = '42501'; end if;
	if p_action = 'start' then perform public.qorpera_assert_wake_work_allowed((p_binding ->> 'runId')::uuid); end if;
	select * into v_machine from public.qorpera_company_machines where id = v_machine_id for update;
	if v_machine.id is null or v_machine.profile_id::text is distinct from v_identity ->> 'companyId' or v_machine.removed_at is not null then
		raise exception 'Machine command authority unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	-- The agent hears this one: it waits, wakes the machine or picks another.
	if v_machine.desired_state <> 'running' or v_placement.running_at is null or not public.qorpera_company_machine_placement_reserved(v_placement.id) then
		return jsonb_build_object('schema','qorpera.machine-command-authority/v1','state','refused','reason','MACHINE_NOT_RUNNING',
			'machine',v_machine.name,'machineState',public.qorpera_company_machine_state(v_machine)); end if;
	select * into v_receipt from public.qorpera_run_operation_receipts where id = p_command_id;
	if not found or v_receipt.operation_kind <> 'cloud_tool' or left(v_receipt.logical_operation_key, length('machine_run:')) <> 'machine_run:'
		or v_receipt.requires_company_revision
		or not exists (select 1 from public.qorpera_execution_runs run where run.id = v_receipt.run_id and run.profile_id = v_machine.profile_id)
		or (p_action = 'start' and (v_receipt.run_id::text is distinct from p_binding ->> 'runId' or v_receipt.status not in ('executing','completed')
			or v_receipt.input_sha256 is distinct from p_input_sha256)) then
		raise exception 'Machine command authority unavailable' using errcode = '42501'; end if;
	select * into v_command from public.qorpera_company_machine_commands where id = p_command_id;
	if v_command.id is not null and v_command.machine_id <> v_machine.id then
		raise exception 'Machine command authority unavailable' using errcode = '42501'; end if;
	-- A command whose placement is gone (its machine stopped and moved) left its log on that disk;
	-- a start that never reached the guest and was given up (lost) is never started late. A command
	-- that ran to its end is answered from the guest, never run again.
	if v_command.id is not null and (v_command.placement_id is distinct from v_placement.id
		or (p_action = 'start' and v_command.state = 'lost')) then
		return jsonb_build_object('schema','qorpera.machine-command-authority/v1','state','refused','reason','MACHINE_COMMAND_ENDED',
			'machine',v_machine.name,'commandState',v_command.state); end if;
	if p_action = 'start' then
		if v_command.id is null then
			insert into public.qorpera_company_machine_commands(id, machine_id, run_id, staff_agent_id, placement_id, command_head, notify)
			values (p_command_id, v_machine.id, v_receipt.run_id, (v_identity ->> 'staffAgentId')::uuid, v_placement.id, p_detail ->> 'commandHead',
				(p_detail ->> 'notify')::boolean)
			returning * into v_command;
		elsif v_command.machine_id <> v_machine.id or v_command.command_head <> p_detail ->> 'commandHead'
			or v_command.notify <> (p_detail ->> 'notify')::boolean then
			raise exception 'Machine command authority unavailable' using errcode = '42501';
		elsif v_command.ended_at is null then
			-- Sent again: the guest's two minutes to know it start over.
			update public.qorpera_company_machine_commands set sent_at = clock_timestamp() where id = v_command.id;
		end if;
		-- The run that asked for the machine has now used it: no separate "running" wake.
		update public.qorpera_company_machines set notify_run_ids = array_remove(notify_run_ids, v_receipt.run_id)
		where id = v_machine.id and v_receipt.run_id = any(notify_run_ids);
	elsif v_command.id is null or v_command.machine_id <> v_machine.id then
		raise exception 'Machine command authority unavailable' using errcode = '42501'; end if;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() where id = v_machine.id;
	return jsonb_build_object('schema','qorpera.machine-command-authority/v1','state','authorized','machineId',v_machine.id,
		'machine',v_machine.name,'placementId',v_placement.id,'commandId',p_command_id,
		'inputSha256',v_receipt.input_sha256,'operationKey',substring(v_receipt.logical_operation_key from length('machine_run:') + 1),
		'runId',v_receipt.run_id,'executorOwner',v_placement.owner,'providerId',v_placement.binding ->> 'providerId',
		'instanceSha256',v_placement.instance_sha256,'bootId',v_placement.boot_id,'identity',v_identity);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Executor authority
-- ---------------------------------------------------------------------------
-- Custody of a placement belongs to the executor of its node. Internal: locks
-- the machine, then the placement, and checks the executor's exact binding text.
create function public.qorpera_company_machine_custody(p_placement_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns public.qorpera_company_machine_placements language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_placement_id is null or octet_length(coalesce(p_binding_text,'')) not between 2 and 16384
		or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Machine custody required' using errcode = '42501'; end if;
	perform 1 from public.qorpera_company_machines machine join public.qorpera_company_machine_placements placement
		on placement.machine_id = machine.id where placement.id = p_placement_id for update of machine;
	select * into v_placement from public.qorpera_company_machine_placements where id = p_placement_id for update;
	if v_placement.id is null or v_placement.owner is distinct from p_owner or v_placement.machine_id_sha256 is distinct from p_machine_id_sha256
		or v_placement.binding is distinct from p_binding_text::jsonb
		or v_placement.instance_sha256 is distinct from encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex') then
		raise exception 'Machine custody differs' using errcode = '42501'; end if;
	return v_placement;
end
$$;

-- The executor's list: every placement on its node that still exists, with
-- what it should do next. Every effect re-checks its own custody.
create function public.qorpera_list_executor_machines(p_owner text, p_machine_id_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Machine custody required' using errcode = '42501'; end if;
	return coalesce((select jsonb_agg(entry order by entry ->> 'createdAt', entry ->> 'placementId') from (
		select jsonb_build_object('schema','qorpera.company-machine-state/v2','machineId',machine.id,'placementId',placement.id,
			'binding',placement.binding,'bindingText',public.qorpera_company_machine_binding_text(placement.binding),
			'instanceSha256',placement.instance_sha256,'retired',placement.retired_at is not null,
			'desiredState',case when placement.retired_at is not null then 'deleted' else machine.desired_state end,
			'lifetime',machine.lifetime,'reserved',state.reserved,'asleepSince',demand.suspended_at,
			'removing',placement.removing_at is not null,'released',state.released,'runningAt',placement.running_at,'bootId',placement.boot_id,
			'lastUsedAt',machine.last_used_at,'createdAt',placement.created_at,'lastError',machine.last_error,
			'commands',case when placement.retired_at is null then coalesce((select jsonb_agg(command.id order by command.started_at, command.id) from (
				select id, started_at from public.qorpera_company_machine_commands where machine_id = machine.id and ended_at is null
				order by started_at, id limit 64) command), '[]'::jsonb) else '[]'::jsonb end,
			'sleepDue',placement.retired_at is null and machine.lifetime = 'task' and machine.desired_state = 'running' and state.reserved
				and not exists (select 1 from public.qorpera_company_machine_commands where machine_id = machine.id and ended_at is null)
				and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.sleep_after_seconds),
			'stopDue',(placement.retired_at is not null or machine.desired_state <> 'running') and state.reserved,
			'removeDue',placement.retired_at is not null or machine.desired_state = 'deleted' or state.released
				or (machine.lifetime = 'task' and machine.desired_state = 'stopped' and demand.suspended_at is not null
					and demand.suspended_at <= clock_timestamp() - make_interval(secs => executor.remove_after_seconds))) entry
		from public.qorpera_company_machine_placements placement
		join public.qorpera_company_machines machine on machine.id = placement.machine_id
		join public.qorpera_machine_executors executor on executor.owner = placement.owner
		left join public.qorpera_runtime_node_demands demand on demand.allocation_id = placement.id and demand.released_at is null
		left join public.qorpera_runtime_machine_allocations allocation on allocation.id = placement.id
		cross join lateral (select public.qorpera_company_machine_placement_reserved(placement.id) as reserved,
			allocation.released_at is not null as released) state
		where placement.owner = p_owner and placement.machine_id_sha256 = p_machine_id_sha256 and placement.removed_at is null) listed), '[]'::jsonb);
end
$$;

-- Each call gives at most one waiting machine room, the first in line that
-- fits this node now (a machine too large for it or for its free room and
-- disk now, of a paused company, or one this node could never take, never
-- holds up the ones behind it). A machine asleep anywhere wakes where
-- it slept if there is room there; otherwise it may start fresh here. One
-- reservation per transaction, and every refused attempt is rolled back with
-- its locks, so the node's pass never holds one company's locks while it
-- waits for another's; the executor calls again until nothing is admitted.
-- With nothing to admit, the first machine in line that lacks only disk that
-- stopped machines hold on this node gets it: their scratch disks are given
-- up, the longest asleep first, and it takes the disk once their deletes are
-- proven. And a task machine asleep past the removal delay with no disk left
-- on any node is removed (nothing else would ever list it).
create function public.qorpera_admit_executor_machines(p_owner text, p_machine_id_sha256 text, p_limit integer default 16)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_executor public.qorpera_machine_executors%rowtype; v_machine public.qorpera_company_machines%rowtype; v_result jsonb;
	v_shape record; v_room record; v_disk bigint; v_freeing bigint; v_need bigint; v_asleep record;
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Machine custody required' using errcode = '42501'; end if;
	select * into v_executor from public.qorpera_machine_executors where owner = p_owner and machine_id_sha256 = p_machine_id_sha256;
	if v_executor.owner is null then return '[]'::jsonb; end if;
	select provider.cpu_millis, provider.memory_bytes into v_shape from public.qorpera_runtime_node_providers provider
	join public.qorpera_runtime_nodes node on node.id = provider.node_id and node.machine_id_sha256 = p_machine_id_sha256
	where v_executor.enabled and provider.provider_kind = 'machine' and provider.provider_id = v_executor.policy ->> 'providerId'
		and provider.policy_sha256 = v_executor.policy ->> 'providerPolicySha256';
	select public.qorpera_runtime_node_cpu_budget(node) - coalesce(sum(demand.cpu_millis), 0) as cpu,
		node.memory_bytes - node.headroom_memory_bytes - coalesce(sum(demand.memory_bytes), 0) as memory into v_room
	from public.qorpera_runtime_nodes node
	left join public.qorpera_runtime_node_demands demand on demand.node_id = node.id and demand.reserved_at is not null
		and demand.released_at is null and demand.suspended_at is null
	where node.machine_id_sha256 = p_machine_id_sha256 and node.enabled group by node.id;
	v_disk := v_executor.disk_bytes - public.qorpera_machine_executor_disk_used(p_owner);
	if v_shape.cpu_millis is not null and v_room.cpu is not null then
		for v_machine in select machine.* from public.qorpera_company_machines machine
			left join public.qorpera_company_machine_placements here on here.machine_id = machine.id
				and here.retired_at is null and here.removed_at is null
			where machine.desired_state = 'running' and machine.removed_at is null and not public.qorpera_company_machine_reserved(machine)
				and not public.qorpera_company_execution_paused(machine.profile_id)
				and machine.cpus::bigint * 1000 <= least(v_shape.cpu_millis, v_room.cpu)
				and machine.memory_bytes <= least(v_shape.memory_bytes, v_room.memory)
				-- Asleep here, it wakes on the disk it already holds; anything else needs new disk and must be free to come.
				and (here.owner = p_owner or (machine.disk_bytes <= v_disk and machine.repository_worker_id is null
					and (here.id is null or here.running_at is null))
					or (here.id is null and machine.disk_bytes <= v_disk and exists (select 1 from public.qorpera_coding_storage_volumes volume
						where volume.worker_id = machine.repository_worker_id and volume.owner = p_owner
							and volume.machine_id_sha256 = p_machine_id_sha256)))
			order by machine.wanted_at, machine.id limit p_limit loop
			begin
				if not pg_try_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || v_machine.profile_id::text, 0)) then
					raise sqlstate 'P0F04'; end if;
				select * into v_machine from public.qorpera_company_machines where id = v_machine.id for update nowait;
				v_result := public.qorpera_admit_company_machine(v_machine.id, p_owner);
				if v_result ->> 'state' = 'reserved' then return jsonb_build_array(v_machine.id); end if;
				raise sqlstate 'P0F04';
			exception when lock_not_available or sqlstate 'P0F04' then continue;
			end;
		end loop;
		-- Disks already being deleted here count as coming free.
		select coalesce(sum(machine.disk_bytes), 0) into v_freeing from public.qorpera_company_machine_placements placement
		join public.qorpera_company_machines machine on machine.id = placement.machine_id
		where placement.owner = p_owner and placement.retired_at is not null and placement.removed_at is null;
		select machine.* into v_machine from public.qorpera_company_machines machine
		left join public.qorpera_company_machine_placements here on here.machine_id = machine.id
			and here.retired_at is null and here.removed_at is null
		where machine.desired_state = 'running' and machine.removed_at is null and not public.qorpera_company_machine_reserved(machine)
			and not public.qorpera_company_execution_paused(machine.profile_id)
			and machine.cpus::bigint * 1000 <= least(v_shape.cpu_millis, v_room.cpu)
			and machine.memory_bytes <= least(v_shape.memory_bytes, v_room.memory)
			and here.owner is distinct from p_owner and machine.disk_bytes > v_disk + v_freeing
			and ((machine.repository_worker_id is null and (here.id is null or here.running_at is null))
				or (here.id is null and exists (select 1 from public.qorpera_coding_storage_volumes volume
					where volume.worker_id = machine.repository_worker_id and volume.owner = p_owner
						and volume.machine_id_sha256 = p_machine_id_sha256)))
		order by machine.wanted_at, machine.id limit 1;
		v_need := v_machine.disk_bytes - v_disk - v_freeing;
		if v_machine.id is not null and v_need <= (select coalesce(sum(machine.disk_bytes), 0)
			from public.qorpera_company_machine_placements placement
			join public.qorpera_company_machines machine on machine.id = placement.machine_id
			join public.qorpera_runtime_node_demands demand on demand.allocation_id = placement.id
			where placement.owner = p_owner and placement.retired_at is null and placement.removed_at is null
				and machine.desired_state = 'stopped' and demand.suspended_at is not null and demand.released_at is null) then
			for v_asleep in select placement.id, placement.profile_id, machine.id as machine_id, machine.disk_bytes
				from public.qorpera_company_machine_placements placement
				join public.qorpera_company_machines machine on machine.id = placement.machine_id
				join public.qorpera_runtime_node_demands demand on demand.allocation_id = placement.id
				where placement.owner = p_owner and placement.retired_at is null and placement.removed_at is null
					and machine.desired_state = 'stopped' and demand.suspended_at is not null and demand.released_at is null
				order by demand.suspended_at, placement.id loop
				exit when v_need <= 0;
				begin
					if not pg_try_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || v_asleep.profile_id::text, 0)) then
						raise sqlstate 'P0F04'; end if;
					perform 1 from public.qorpera_company_machines where id = v_asleep.machine_id and desired_state = 'stopped' for update nowait;
					if not found then raise sqlstate 'P0F04'; end if;
					update public.qorpera_company_machine_placements set retired_at = clock_timestamp()
					where id = v_asleep.id and retired_at is null and removed_at is null;
					if found then v_need := v_need - v_asleep.disk_bytes; end if;
				exception when lock_not_available or sqlstate 'P0F04' then continue;
				end;
			end loop;
		end if;
	end if;
	for v_machine in select machine.* from public.qorpera_company_machines machine
		where machine.desired_state = 'stopped' and machine.lifetime = 'task' and machine.removed_at is null
			and machine.updated_at <= clock_timestamp() - make_interval(secs => v_executor.remove_after_seconds)
			and not exists (select 1 from public.qorpera_company_machine_placements placement
				where placement.machine_id = machine.id and placement.removed_at is null)
		order by machine.updated_at, machine.id limit 8 loop
		begin
			if not pg_try_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || v_machine.profile_id::text, 0)) then
				raise sqlstate 'P0F04'; end if;
			select * into v_machine from public.qorpera_company_machines where id = v_machine.id and desired_state = 'stopped'
				and removed_at is null for update nowait;
			if v_machine.id is not null and not exists (select 1 from public.qorpera_company_machine_placements placement
				where placement.machine_id = v_machine.id and placement.removed_at is null) then
				perform public.qorpera_set_company_machine_desired(v_machine, 'deleted', 'kernel'); end if;
		exception when lock_not_available or sqlstate 'P0F04' then continue;
		end;
	end loop;
	return '[]'::jsonb;
end
$$;

-- A few seconds of authority for one LXD effect on a placement, in the coding
-- machine's receipt shape (checkCodingMachineReceipt). run: it is its
-- machine's current placement, wanted running, and holds its node room (a
-- wake re-reserves it or is refused on a full node). stop: it is retired, or
-- its machine is wanted stopped or deleted, or it is an idle task machine
-- past the node's sleep delay (the kernel then wants it stopped). delete: it
-- is retired or its machine is wanted deleted, or it is a task machine asleep
-- past the removal delay, and it holds no awake room; granting it is irreversible.
create function public.qorpera_authorize_executor_machine(p_placement_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text,
	p_intent text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_executor public.qorpera_machine_executors%rowtype; v_demand public.qorpera_runtime_node_demands%rowtype;
	v_node public.qorpera_runtime_nodes%rowtype; v_reservation jsonb;
begin
	if p_intent is null or p_intent not in ('run','stop','delete') then raise exception 'Machine custody input invalid' using errcode = '22023'; end if;
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	if v_placement.removed_at is not null then raise exception 'Machine placement was removed' using errcode = '42501'; end if;
	select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	select * into strict v_executor from public.qorpera_machine_executors where owner = p_owner;
	if p_intent = 'run' then
		if v_placement.retired_at is not null or v_machine.desired_state <> 'running' or v_placement.removing_at is not null then
			return '{"state":"refused","reason":"MACHINE_NOT_WANTED_RUNNING"}'::jsonb; end if;
		if not v_executor.enabled then return '{"state":"refused","reason":"MACHINES_DISABLED"}'::jsonb; end if;
		v_reservation := public.qorpera_reserve_runtime_node_machine(v_placement.id, 'machine', v_placement.binding ->> 'providerId',
			v_placement.binding ->> 'providerPolicySha256', v_placement.instance_sha256, p_machine_id_sha256,
			v_machine.cpus::bigint * 1000, v_machine.memory_bytes);
		if v_reservation ->> 'state' <> 'reserved' then return v_reservation; end if;
		return jsonb_build_object('schema','qorpera.coding-machine-admission/v1','machineId',v_placement.id,'workerId',null,
			'instanceSha256',v_placement.instance_sha256,'intent','run','guestUid',null,'validForMs',(v_reservation ->> 'validForMs')::integer,
			'nodeId',v_reservation -> 'nodeId','nodeVersion',v_reservation -> 'nodeVersion');
	end if;
	select * into v_demand from public.qorpera_runtime_node_demands where allocation_id = v_placement.id and provider_kind = 'machine';
	select * into v_node from public.qorpera_runtime_nodes where id = v_demand.node_id;
	if v_demand.allocation_id is null or v_demand.released_at is not null or v_node.machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Machine node custody differs' using errcode = '42501'; end if;
	if p_intent = 'stop' then
		if v_placement.retired_at is null and v_machine.desired_state = 'running' then
			-- Only an idle task machine sleeps on its own (one that never came up too: it gives its room back).
			if v_machine.lifetime <> 'task'
				or exists (select 1 from public.qorpera_company_machine_commands where machine_id = v_machine.id and ended_at is null)
				or v_machine.last_used_at > clock_timestamp() - make_interval(secs => v_executor.sleep_after_seconds) then
				return '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb; end if;
			v_machine := public.qorpera_set_company_machine_desired(v_machine, 'stopped', 'kernel');
		end if;
		update public.qorpera_company_machine_placements set stop_authorized_at = clock_timestamp() where id = v_placement.id;
	else
		if v_demand.reserved_at is not null and v_demand.suspended_at is null then
			return '{"state":"refused","reason":"MACHINE_AWAKE"}'::jsonb; end if;
		if v_placement.retired_at is null and v_machine.desired_state <> 'deleted' then
			if v_machine.lifetime <> 'task' or v_machine.desired_state <> 'stopped' or v_demand.suspended_at is null
				or v_demand.suspended_at > clock_timestamp() - make_interval(secs => v_executor.remove_after_seconds) then
				return '{"state":"refused","reason":"MACHINE_NOT_DUE"}'::jsonb; end if;
			v_machine := public.qorpera_set_company_machine_desired(v_machine, 'deleted', 'kernel');
		end if;
		update public.qorpera_company_machine_placements set removing_at = coalesce(removing_at, clock_timestamp()) where id = v_placement.id;
	end if;
	return jsonb_build_object('schema','qorpera.coding-machine-admission/v1','machineId',v_placement.id,'workerId',null,
		'instanceSha256',v_placement.instance_sha256,'intent',p_intent,'guestUid',null,'validForMs',5000,
		'nodeId',v_node.id,'nodeVersion',v_node.version);
end
$$;

-- The guest came up in this boot and the executor holds its lease: the
-- machine is running. Commands of an earlier boot or placement are gone; the
-- runs that asked for the machine and have not used it yet are woken.
create function public.qorpera_mark_company_machine_running(p_placement_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text,
	p_boot_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
begin
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	if p_boot_id is null or v_placement.removed_at is not null or v_placement.retired_at is not null or v_machine.desired_state <> 'running'
		or not public.qorpera_company_machine_placement_reserved(v_placement.id) then
		return jsonb_build_object('state','kept','machine',public.qorpera_company_machine_view(v_machine)); end if;
	if v_placement.boot_id is distinct from p_boot_id then
		perform public.qorpera_end_company_machine_commands(v_machine, 'lost');
		update public.qorpera_company_machine_placements set running_at = clock_timestamp(), boot_id = p_boot_id where id = v_placement.id;
		update public.qorpera_company_machines set last_used_at = clock_timestamp(),
			last_error = case when last_error like 'start:%' or last_error like 'guest:%' then null else last_error end,
			last_error_at = case when last_error like 'start:%' or last_error like 'guest:%' then null else last_error_at end,
			updated_at = clock_timestamp()
		where id = v_machine.id returning * into v_machine;
		if cardinality(v_machine.notify_run_ids) > 0 then
			insert into public.qorpera_company_machine_events(machine_id, profile_id, environment_id, staff_agent_id, parent_run_id, kind)
			select v_machine.id, v_machine.profile_id, v_machine.environment_id, run.staff_agent_id, run.id, 'running'
			from public.qorpera_execution_runs run where run.id = any(v_machine.notify_run_ids) order by run.id;
			update public.qorpera_company_machines set notify_run_ids = '{}' where id = v_machine.id returning * into v_machine;
		end if;
	end if;
	return jsonb_build_object('state','running','machine',public.qorpera_company_machine_view(v_machine));
end
$$;

-- After a confirmed power-off: the node room is given back; its scratch disk
-- stays on the node for a wake there. If the machine was woken in the
-- meantime, the room is kept and it starts again.
create function public.qorpera_suspend_company_machine(p_placement_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_demand public.qorpera_runtime_node_demands%rowtype;
begin
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	if v_placement.removed_at is not null then raise exception 'Machine placement was removed' using errcode = '42501'; end if;
	select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	-- Its programs stopped with it, whatever happens to the room.
	if v_placement.retired_at is null then perform public.qorpera_end_company_machine_commands(v_machine, 'lost'); end if;
	update public.qorpera_company_machine_placements set running_at = null, boot_id = null where id = v_placement.id returning * into v_placement;
	if (v_placement.retired_at is null and v_machine.desired_state = 'running') or v_placement.stop_authorized_at is null then
		return '{"state":"kept","reason":"MACHINE_WANTED_RUNNING"}'::jsonb; end if;
	perform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);
	perform 1 from public.qorpera_runtime_machine_allocations where id = v_placement.id and released_at is null for update;
	if not found then raise exception 'Machine allocation unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_runtime_nodes node join public.qorpera_runtime_node_demands demand on demand.node_id = node.id
	where demand.allocation_id = v_placement.id and node.machine_id_sha256 = p_machine_id_sha256 for update of node;
	if not found then raise exception 'Machine node custody differs' using errcode = '42501'; end if;
	select * into strict v_demand from public.qorpera_runtime_node_demands where allocation_id = v_placement.id for update;
	if v_demand.provider_kind <> 'machine' or v_demand.reserved_at is null or v_demand.released_at is not null then
		return '{"state":"kept","reason":"NOT_RESERVED"}'::jsonb; end if;
	if v_demand.suspended_at is null then
		update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = v_placement.id returning * into v_demand;
	end if;
	return jsonb_build_object('state','suspended','machineId',v_machine.id,'placementId',v_placement.id,'asleepSince',v_demand.suspended_at);
end
$$;

-- The executor's deletion proof (its journal holds the accepted LXD delete
-- and LXD knows no such instance) releases the placement's allocation; the
-- node demand follows through the existing trigger. A deleted machine with
-- nothing left on any node is removed. Repeating a release answers the same.
create function public.qorpera_release_company_machine(p_placement_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype;
	v_allocation public.qorpera_runtime_machine_allocations%rowtype;
begin
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	if v_placement.removed_at is null then
		select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_placement.id;
		if v_allocation.id is not null and v_allocation.released_at is null then
			if v_placement.removing_at is null then raise exception 'Machine deletion was not authorized' using errcode = '42501'; end if;
			perform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);
			select * into strict v_allocation from public.qorpera_runtime_machine_allocations where id = v_placement.id for update;
			if v_allocation.instance_sha256 <> v_placement.instance_sha256 or v_allocation.company_machine_placement_id is distinct from v_placement.id then
				raise exception 'Machine allocation differs' using errcode = '42501'; end if;
			update public.qorpera_runtime_machine_allocations set released_at = coalesce(released_at, clock_timestamp()) where id = v_placement.id;
		end if;
		if v_placement.retired_at is null then perform public.qorpera_end_company_machine_commands(v_machine, 'lost'); end if;
		update public.qorpera_company_machine_placements set retired_at = coalesce(retired_at, clock_timestamp()),
			removing_at = coalesce(removing_at, clock_timestamp()), removed_at = clock_timestamp(), running_at = null, boot_id = null
		where id = v_placement.id returning * into v_placement;
		-- Released without being retired first (an operator's release): the machine asks for room again.
		v_machine := public.qorpera_close_company_machine(v_machine);
	end if;
	return jsonb_build_object('state','released','machineId',v_machine.id,'placementId',v_placement.id,'removedAt',v_placement.removed_at,
		'machineRemovedAt',v_machine.removed_at);
end
$$;

-- A node gone for good (its disks are gone and it will never run its executor
-- again; the operator checks that, SQL cannot): an operator gives up its placements. Each allocation is released,
-- its machine's commands there are lost, a deleted machine is removed, and a
-- machine that wants to run starts fresh on another node. Refused while the
-- executor is enabled; answers with how many placements were given up.
create function public.qorpera_abandon_machine_executor(p_owner text, p_machine_id_sha256 text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype; v_count integer := 0;
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Machine operator authority required' using errcode = '42501'; end if;
	if not exists (select 1 from public.qorpera_machine_executors where owner = p_owner and machine_id_sha256 = p_machine_id_sha256 and not enabled) then
		raise exception 'Disable the machine executor first' using errcode = '55000'; end if;
	-- One give-up at a time: it takes several companies' locks.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:abandon', 0));
	for v_placement in select * from public.qorpera_company_machine_placements
		where owner = p_owner and machine_id_sha256 = p_machine_id_sha256 and removed_at is null order by created_at, id loop
		perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || v_placement.profile_id::text, 0));
		select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id for update;
		select * into strict v_placement from public.qorpera_company_machine_placements where id = v_placement.id for update;
		if v_placement.removed_at is not null then continue; end if;
		perform public.qorpera_lock_profile_gc_fence(v_placement.profile_id);
		update public.qorpera_runtime_machine_allocations set released_at = coalesce(released_at, clock_timestamp()) where id = v_placement.id;
		if v_placement.retired_at is null then perform public.qorpera_end_company_machine_commands(v_machine, 'lost'); end if;
		update public.qorpera_company_machine_placements set retired_at = coalesce(retired_at, clock_timestamp()),
			removing_at = coalesce(removing_at, clock_timestamp()), removed_at = clock_timestamp(), running_at = null, boot_id = null
		where id = v_placement.id;
		perform public.qorpera_close_company_machine(v_machine);
		v_count := v_count + 1;
	end loop;
	return v_count;
end
$$;

create function public.qorpera_record_company_machine_error(p_placement_id uuid, p_owner text, p_machine_id_sha256 text, p_stage text, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or p_stage is null or p_stage not in ('start','stop','delete','release','guest','commands')
		or (p_code is not null and p_code !~ '^[A-Z][A-Z0-9_:]{0,119}$') then
		raise exception 'Machine error invalid' using errcode = '22023'; end if;
	update public.qorpera_company_machines machine set last_error = case when p_code is null then null else p_stage || ':' || p_code end,
		last_error_at = case when p_code is null then null else clock_timestamp() end
	from public.qorpera_company_machine_placements placement
	where placement.id = p_placement_id and placement.machine_id = machine.id and placement.owner = p_owner
		and placement.machine_id_sha256 = p_machine_id_sha256 and placement.removed_at is null and machine.removed_at is null
		-- A retired placement's trouble is its old node's, not the machine's.
		and placement.retired_at is null
		and (p_code is not null or machine.last_error like p_stage || ':%');
end
$$;

-- The executor's look inside a running machine: the commands that ended since
-- (each {commandId, state, exitCode, outputTail}) and whether the machine was
-- busy (a program used the processor), which keeps a task machine awake.
create function public.qorpera_record_company_machine_commands(p_placement_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text,
	p_boot_id uuid, p_ended jsonb, p_busy boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_placement public.qorpera_company_machine_placements%rowtype; v_machine public.qorpera_company_machines%rowtype; v_count integer;
begin
	v_placement := public.qorpera_company_machine_custody(p_placement_id, p_owner, p_binding_text, p_machine_id_sha256);
	if jsonb_typeof(p_ended) is distinct from 'array' or jsonb_array_length(p_ended) > 64 or p_busy is null
		or exists (select 1 from jsonb_array_elements(p_ended) item where jsonb_typeof(item) is distinct from 'object'
			or item - array['commandId','state','exitCode','outputTail'] <> '{}'::jsonb
			or coalesce(item ->> 'commandId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			or coalesce(item ->> 'state','') not in ('succeeded','failed','cancelled','lost')
			or (item ->> 'state' in ('succeeded','failed') and (jsonb_typeof(item -> 'exitCode') is distinct from 'number'
				or (item ->> 'exitCode') !~ '^[0-9]{1,3}$' or (item ->> 'exitCode')::integer > 255))
			or (item -> 'outputTail' is not null and jsonb_typeof(item -> 'outputTail') is distinct from 'string')) then
		raise exception 'Machine commands invalid' using errcode = '22023'; end if;
	select * into strict v_machine from public.qorpera_company_machines where id = v_placement.machine_id;
	-- Only what the executor saw in the current placement's current boot counts.
	if v_placement.removed_at is not null or v_placement.retired_at is not null or v_placement.boot_id is distinct from p_boot_id then
		return '{"state":"stale"}'::jsonb; end if;
	v_count := public.qorpera_end_company_machine_commands(v_machine, 'observed', p_ended);
	if p_busy then update public.qorpera_company_machines set last_used_at = clock_timestamp() where id = v_machine.id; end if;
	return jsonb_build_object('state','recorded','ended',v_count);
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Members
-- ---------------------------------------------------------------------------
create function public.qorpera_list_company_machines(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.uid() is null or p_profile_id is null or not public.qorpera_can_read_profile(p_profile_id) then
		raise exception 'Company is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.company-machines/v1','machines',coalesce((select jsonb_agg(
			public.qorpera_company_machine_view(machine) || jsonb_build_object('commands',coalesce((select jsonb_agg(jsonb_build_object(
				'commandId',command.id,'command',command.command_head,'startedAt',command.started_at,'endedAt',command.ended_at,
				'state',coalesce(command.state,'running'),'exitCode',command.exit_code) order by command.started_at desc, command.id)
				from (select * from public.qorpera_company_machine_commands where machine_id = machine.id
					order by started_at desc, id limit 20) command), '[]'::jsonb))
			order by machine.created_at desc, machine.id)
		from public.qorpera_company_machines machine where machine.profile_id = p_profile_id
			and (machine.removed_at is null or machine.removed_at > clock_timestamp() - interval '1 day')), '[]'::jsonb));
end
$$;

-- The machines started from one conversation, for its thread card: a member
-- who can read the conversation sees them (the company's list shows them all).
create function public.qorpera_list_session_machines(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.uid() is null or p_session_id is null or not public.qorpera_can_read_session(p_session_id) then
		raise exception 'Conversation is unavailable' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.session-machines/v1','sessionId',p_session_id,'machines',coalesce((select jsonb_agg(
			public.qorpera_company_machine_view(machine) order by machine.created_at, machine.id)
		from public.qorpera_company_machines machine join public.qorpera_execution_runs run on run.id = machine.started_by_run_id
		where run.session_id = p_session_id
			and (machine.removed_at is null or machine.removed_at > clock_timestamp() - interval '1 day')), '[]'::jsonb));
end
$$;

-- A member stops, wakes or deletes any machine of the company.
create function public.qorpera_member_manage_company_machine(p_profile_id uuid, p_machine_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_company_machines%rowtype;
begin
	if auth.uid() is null or p_profile_id is null or p_machine_id is null or p_action is null or p_action not in ('start','stop','delete') then
		raise exception 'Machine change is invalid' using errcode = '22023'; end if;
	if not public.qorpera_can_write_profile(p_profile_id) then raise exception 'Company is unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.company-machines:' || p_profile_id::text, 0));
	select * into v_machine from public.qorpera_company_machines where id = p_machine_id and profile_id = p_profile_id and removed_at is null for update;
	if v_machine.id is null then raise exception 'Machine is unavailable' using errcode = 'P0002'; end if;
	if p_action = 'start' then
		if v_machine.desired_state = 'deleted' then raise exception 'Machine is being deleted' using errcode = '55000'; end if;
		-- It takes its place in line; the nodes' next pass gives it room.
		if v_machine.desired_state <> 'running' then
			update public.qorpera_company_machines set desired_state = 'running', desired_by = 'member', wanted_at = clock_timestamp(),
				last_used_at = clock_timestamp(), updated_at = clock_timestamp()
			where id = v_machine.id returning * into v_machine;
			update public.qorpera_company_machine_placements set stop_authorized_at = null
			where id = (public.qorpera_company_machine_placement(v_machine.id)).id;
		end if;
	else
		v_machine := public.qorpera_set_company_machine_desired(v_machine, case when p_action = 'stop' then 'stopped' else 'deleted' end, 'member');
	end if;
	return public.qorpera_company_machine_view(v_machine);
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Machine events wake their runs
-- ---------------------------------------------------------------------------
do $$
begin
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_wake_occurrences_source_kind_check'
		and conrelid = 'public.qorpera_wake_occurrences'::regclass)) is distinct from
		'CHECK ((source_kind = ANY (ARRAY[''input''::text, ''schedule''::text, ''company-file''::text, ''coworker''::text, ''room''::text, ''office-activation''::text, ''worker-dispatch''::text, ''worker-completion''::text])))' then
		raise exception 'Wake source kinds differ from 20260922170000';
	end if;
end
$$;
alter table public.qorpera_wake_occurrences drop constraint qorpera_wake_occurrences_source_kind_check;
alter table public.qorpera_wake_occurrences add constraint qorpera_wake_occurrences_source_kind_check
	check (source_kind in ('input','schedule','company-file','coworker','room','office-activation','worker-dispatch','worker-completion','machine-event'));

-- A machine event continues the run that caused it, in that run's
-- conversation, exactly like a worker's report.
create function public.qorpera_machine_wake_ancestry(p_wake public.qorpera_wake_occurrences)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_event public.qorpera_company_machine_events%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_wake public.qorpera_wake_occurrences%rowtype;
begin
	select * into v_event from public.qorpera_company_machine_events where id = p_wake.source_id;
	select * into v_parent from public.qorpera_execution_runs where id = p_wake.parent_run_id;
	select * into v_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	if v_event.id is null or v_parent.id is null or v_wake.id is null or p_wake.wake_kind <> 'agent'
		or p_wake.source_kind <> 'machine-event' or p_wake.trigger_id is distinct from 'machine-event'
		or v_event.parent_run_id is distinct from v_parent.id
		or v_event.profile_id is distinct from p_wake.profile_id or v_event.environment_id is distinct from p_wake.environment_id
		or v_event.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.profile_id is distinct from p_wake.profile_id or v_parent.environment_id is distinct from p_wake.environment_id
		or v_parent.staff_agent_id is distinct from p_wake.staff_agent_id
		or v_parent.requested_by_user_id is distinct from p_wake.requested_by_user_id
		or p_wake.file_event_id is not null or p_wake.session_id is distinct from v_parent.session_id
		or v_wake.causal_root_id is null or cardinality(v_wake.causal_agent_ids) < 1
		or v_wake.causal_agent_ids[cardinality(v_wake.causal_agent_ids)] is distinct from v_parent.staff_agent_id then
		return null; end if;
	return jsonb_build_object('rootId', v_wake.causal_root_id, 'agentIds', to_jsonb(v_wake.causal_agent_ids));
end
$$;

-- An event as the agent reads it. The wake itself carries only the last
-- p_tail_bytes of the output (a wake is small); the continuation carries all
-- that was kept, and machine_read the whole log.
create function public.qorpera_machine_event_view(p_event public.qorpera_company_machine_events, p_tail_bytes integer)
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('machine', machine.name, 'machineId', machine.id, 'kind', p_event.kind, 'at', p_event.created_at,
		'machineState', public.qorpera_company_machine_state(machine),
		'command', command.command_head, 'commandId', command.id, 'commandState', command.state, 'exitCode', command.exit_code,
		'outputTail', public.qorpera_machine_text_tail(command.output_tail, p_tail_bytes))
	from public.qorpera_company_machines machine
	left join public.qorpera_company_machine_commands command on command.id = p_event.command_id
	where machine.id = p_event.machine_id
$$;

create function public.qorpera_machine_event_payload(p_parent_run_id uuid, p_event_ids uuid[])
returns jsonb language sql stable security definer set search_path = '' as $$
	select jsonb_build_object('schema','qorpera.machine-event/v1','parentRunId',p_parent_run_id,
		'events',(select jsonb_agg(public.qorpera_machine_event_view(event, 600) order by event.created_at, event.id)
			from public.qorpera_company_machine_events event where event.id = any(p_event_ids)),
		'stillWaiting',(select count(*) from public.qorpera_company_machine_events event
			where event.parent_run_id = p_parent_run_id and event.delivery = 'waiting' and not (event.id = any(p_event_ids))))
$$;

-- A person stopped a machine continuation of this run: like stopping the run.
create function public.qorpera_machine_revival_stopped(p_parent_run_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_wake_occurrences revival
		join public.qorpera_execution_runs revival_run on revival_run.id = revival.run_id
		join public.qorpera_runner_jobs revival_job on revival_job.id = revival_run.job_id
		where revival.parent_run_id = p_parent_run_id and revival.source_kind = 'machine-event' and revival_job.status = 'cancelled')
$$;

-- Delivery, as for workers' reports: the parent's own run ends first; one
-- continuation at a time per parent, up to eight events each and never more
-- than a wake holds (the rest follow in the next); a run a person stopped,
-- or whose machine continuation a person stopped, hears nothing more; a
-- paused company waits. Nothing one event does stops the drain.
create function public.qorpera_drain_machine_wakes(p_limit integer default 32)
returns void language plpgsql security definer set search_path = '' as $$
declare v_event public.qorpera_company_machine_events%rowtype; v_parent public.qorpera_execution_runs%rowtype; v_status text;
	v_ids uuid[]; v_id uuid; v_inserted public.qorpera_wake_occurrences%rowtype; v_payload jsonb;
begin
	if auth.role() is distinct from 'service_role' or p_limit is null or p_limit not between 1 and 64 then
		raise exception 'Machine wake admission authority or bound is invalid' using errcode = '42501'; end if;
	for v_event in select * from public.qorpera_company_machine_events where delivery = 'waiting'
		order by scanned_at, created_at, id for update skip locked limit p_limit loop
		begin
			update public.qorpera_company_machine_events set scanned_at = clock_timestamp() where id = v_event.id;
			select * into v_parent from public.qorpera_execution_runs where id = v_event.parent_run_id;
			if v_parent.id is null or v_parent.job_id is null then
				update public.qorpera_company_machine_events set delivery = 'undeliverable' where id = v_event.id; continue; end if;
			select status into v_status from public.qorpera_runner_jobs where id = v_parent.job_id;
			if v_status is null or v_status in ('queued','leased') then continue; end if;
			if v_status = 'cancelled' or public.qorpera_machine_revival_stopped(v_parent.id) then
				update public.qorpera_company_machine_events set delivery = 'suppressed' where id = v_event.id; continue; end if;
			if public.qorpera_company_execution_paused(v_parent.profile_id) then continue; end if;
			perform public.qorpera_serialize_wake_admission(v_parent.profile_id);
			if exists (select 1 from public.qorpera_wake_occurrences pending
				left join public.qorpera_execution_runs pending_run on pending_run.id = pending.run_id
				left join public.qorpera_runner_jobs pending_job on pending_job.id = pending_run.job_id
				where pending.parent_run_id = v_parent.id and pending.source_kind = 'machine-event'
					and (pending.status = 'queued' or (pending.status = 'materialized'
						and (pending_job.id is null or pending_job.status in ('queued','leased'))))) then continue; end if;
			select array_agg(ready.id order by ready.created_at, ready.id) into v_ids from (
				select event.id, event.created_at from public.qorpera_company_machine_events event
				where event.parent_run_id = v_parent.id and event.delivery = 'waiting'
				order by event.created_at, event.id limit 8 for update skip locked) ready;
			if v_ids is null or not (v_event.id = any(v_ids)) then continue; end if;
			-- A wake holds 8 KiB: one event always fits (a 300-character command, a 600-byte tail).
			v_payload := public.qorpera_machine_event_payload(v_parent.id, v_ids);
			while pg_column_size(v_payload) > 6144 and cardinality(v_ids) > 1 loop
				v_ids := v_ids[1:cardinality(v_ids) - 1];
				v_payload := public.qorpera_machine_event_payload(v_parent.id, v_ids);
			end loop;
			-- Each attempt is its own wake: one a pause cancelled at admission never blocks the next.
			v_id := extensions.gen_random_uuid();
			insert into public.qorpera_wake_occurrences(id, profile_id, environment_id, wake_kind, source_kind, source_id, staff_agent_id,
				parent_run_id, trigger_id, occurrence_key, scheduled_for, not_before, payload)
			values (v_id, v_parent.profile_id, v_parent.environment_id, 'agent', 'machine-event', v_ids[1], v_parent.staff_agent_id,
				v_parent.id, 'machine-event', 'machine-event:' || v_id::text, clock_timestamp(), clock_timestamp(), v_payload)
			returning * into v_inserted;
			-- A pause at admission cancels the wake; the events stay waiting for the next drain.
			if v_inserted.status <> 'queued' then continue; end if;
			update public.qorpera_company_machine_events set delivery = 'delivered', occurrence_id = v_id where id = any(v_ids);
		exception when lock_not_available or deadlock_detected then continue;
			when insufficient_privilege or no_data_found or object_not_in_prerequisite_state
				or check_violation or unique_violation or program_limit_exceeded then
				-- The agent, the requester or the conversation is gone, or the event cannot be carried.
				update public.qorpera_company_machine_events set delivery = 'undeliverable' where id = v_event.id;
		end;
	end loop;
end
$$;

-- What the continuation shows: the events it carries and what the parent run
-- already did, like a worker completion continuation.
create function public.qorpera_machine_run_continuation(p_run public.qorpera_execution_runs, p_depth integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_wake public.qorpera_wake_occurrences%rowtype; v_parent public.qorpera_execution_runs%rowtype;
	v_parent_wake public.qorpera_wake_occurrences%rowtype; v_inputs jsonb; v_receipts jsonb; v_sends jsonb; v_result jsonb;
	v_receipt_count bigint; v_send_count bigint;
begin
	select * into v_wake from public.qorpera_wake_occurrences where run_id = p_run.id and source_kind = 'machine-event';
	if not found then return null; end if;
	if p_depth > 2 then return jsonb_build_object('schema','qorpera.machine-event-continuation/v1','omitted','earlier history'); end if;
	select * into strict v_parent from public.qorpera_execution_runs where id = v_wake.parent_run_id
		and profile_id = p_run.profile_id and environment_id = p_run.environment_id and staff_agent_id = p_run.staff_agent_id;
	select * into strict v_parent_wake from public.qorpera_wake_occurrences where run_id = v_parent.id;
	select coalesce(jsonb_agg(public.qorpera_company_context_source(v_parent,'input',input_id) order by ordinal),'[]') into v_inputs
	from unnest(v_parent.input_ids) with ordinality ids(input_id, ordinal);
	select coalesce(jsonb_agg(kept.item order by kept.completed_at, kept.id),'[]') into v_receipts
	from (select receipt.id, receipt.completed_at, listed.item,
			sum(octet_length(listed.item::text)) over (order by receipt.completed_at desc, receipt.id desc) as tail
		from public.qorpera_run_operation_receipts receipt
		cross join lateral (select jsonb_build_object('receiptId',receipt.id,'logicalOperationKey',receipt.logical_operation_key,'completedAt',receipt.completed_at,
			'result',receipt.result,'outputSnapshotId',receipt.output_snapshot_id,'companyPathProposalId',receipt.company_path_proposal_id) as item) listed
		where receipt.run_id = v_parent.id and receipt.status = 'completed') kept
	where kept.tail <= 6291456;
	select count(*) into v_receipt_count from public.qorpera_run_operation_receipts receipt where receipt.run_id = v_parent.id and receipt.status = 'completed';
	select coalesce(jsonb_agg(kept.item order by kept.sequence, kept.event_id),'[]') into v_sends
	from (select event.sequence, event.event_id, listed.item,
			sum(octet_length(listed.item::text)) over (order by event.sequence desc, event.event_id desc) as tail
		from public.qorpera_agent_sends send join public.qorpera_session_events event on event.event_id = send.event_id
		cross join lateral (select jsonb_build_object('eventId',event.event_id,'sequence',event.sequence,'body',event.body) as item) listed
		where send.run_id = v_parent.id) kept
	where kept.tail <= 2097152;
	select count(*) into v_send_count from public.qorpera_agent_sends send
		join public.qorpera_session_events event on event.event_id = send.event_id where send.run_id = v_parent.id;
	v_result := jsonb_build_object('schema','qorpera.machine-event-continuation/v1','runId',p_run.id,'parentRunId',v_parent.id,
		'parentOutcome',(select status from public.qorpera_runner_jobs where id = v_parent.job_id),
		'events',(select coalesce(jsonb_agg(public.qorpera_machine_event_view(event, 4000) order by event.created_at, event.id),'[]')
			from public.qorpera_company_machine_events event where event.occurrence_id = v_wake.id),
		'parentInputs',v_inputs,
		'parentWake',jsonb_build_object('kind',v_parent_wake.wake_kind,'sourceKind',v_parent_wake.source_kind,
			'routineIntent',(select prompt from public.qorpera_cloud_routine_versions
				where routine_id = v_parent_wake.routine_id and version = v_parent_wake.routine_version),
			'roomPost',(select jsonb_build_object('kind','historical_room_input','id',id,'authorUserId',author_user_id,'body',body)
				from public.qorpera_session_inputs where v_parent_wake.source_kind = 'room' and id = v_parent_wake.source_id
					and session_id = v_parent.session_id and kind = 'user_message')),
		'receipts',v_receipts,'priorSends',v_sends,
		'earlier',coalesce(public.qorpera_machine_run_continuation(v_parent, p_depth + 1), public.qorpera_worker_run_continuation(v_parent, p_depth + 1)))
		|| jsonb_strip_nulls(jsonb_build_object(
			'receiptsOmitted',nullif(v_receipt_count - jsonb_array_length(v_receipts),0),
			'priorSendsOmitted',nullif(v_send_count - jsonb_array_length(v_sends),0)));
	if octet_length(v_result::text) > 33554432 then raise exception 'Machine continuation exceeds its bound' using errcode = '54000'; end if;
	return v_result;
end
$$;

-- The wake bus admits, authorizes and describes the new continuation exactly
-- where it does a worker's report.
select pg_temp.company_machine_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$if new.source_kind not in ('coworker','office-activation','worker-dispatch','worker-completion') then$old$,
	$new$if new.source_kind not in ('coworker','office-activation','worker-dispatch','worker-completion','machine-event') then$new$);
select pg_temp.company_machine_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$new.session_id := case when new.source_kind = 'worker-completion' then v_run.session_id$old$,
	$new$new.session_id := case when new.source_kind in ('worker-completion','machine-event') then v_run.session_id$new$);
select pg_temp.company_machine_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
	$old$ elsif new.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(new);$old$,
	$new$ elsif new.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(new);
 elsif new.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(new);$new$);
select pg_temp.company_machine_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$(p_wake.source_kind = 'worker-completion'
					and public.qorpera_company_room_session_staff(id, p_wake.staff_agent_id))$old$,
	$new$(p_wake.source_kind in ('worker-completion','machine-event')
					and public.qorpera_company_room_session_staff(id, p_wake.staff_agent_id))$new$);
select pg_temp.company_machine_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
	$old$ elsif p_wake.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(p_wake);$old$,
	$new$ elsif p_wake.source_kind in ('worker-dispatch','worker-completion') then v_ancestry := public.qorpera_worker_wake_ancestry(p_wake);
 elsif p_wake.source_kind = 'machine-event' then v_ancestry := public.qorpera_machine_wake_ancestry(p_wake);$new$);
select pg_temp.company_machine_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$(v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation','worker-dispatch','worker-completion'))$old$,
	$new$(v_wake.wake_kind = 'agent' and v_wake.source_kind in ('coworker','office-activation','worker-dispatch','worker-completion','machine-event'))$new$);
select pg_temp.company_machine_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
	$old$	if v_wake.source_kind = 'worker-completion' and v_wake.session_id is not null$old$,
	$new$	if v_wake.source_kind in ('worker-completion','machine-event') and v_wake.session_id is not null$new$);
select pg_temp.company_machine_patch('public.qorpera_read_native_wake(jsonb)'::regprocedure,
	$old$ if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion') then v_sender:=null; v_actor_user:=null; end if;$old$,
	$new$ if v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event') then v_sender:=null; v_actor_user:=null; end if;$new$);
select pg_temp.company_machine_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$	perform public.qorpera_drain_worker_wakes(p_limit);$old$,
	$new$	perform public.qorpera_drain_worker_wakes(p_limit);
	perform public.qorpera_drain_machine_wakes(p_limit);$new$);
select pg_temp.company_machine_patch('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure,
	$old$			elsif v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion') then$old$,
	$new$			elsif v_wake.source_kind in ('office-activation','worker-dispatch','worker-completion','machine-event') then$new$);
select pg_temp.company_machine_patch('public.qorpera_run_continuation(public.qorpera_execution_runs)'::regprocedure,
	$old$coalesce(public.qorpera_office_run_continuation(p_run), public.qorpera_worker_run_continuation(p_run))$old$,
	$new$coalesce(public.qorpera_office_run_continuation(p_run), public.qorpera_worker_run_continuation(p_run),
		public.qorpera_machine_run_continuation(p_run))$new$);

-- ---------------------------------------------------------------------------
-- 10. Observations name the new tools
-- ---------------------------------------------------------------------------
select pg_temp.company_machine_patch('public.qorpera_record_runtime_observation(uuid,jsonb)'::regprocedure,
	$old$'organize_sidebar','add_review_rule',$old$,
	$new$'organize_sidebar','add_review_rule','machine_start','machine_run','machine_read','machine_cancel','machine_stop','machine_delete','machine_list',$new$);

-- ---------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_configure_machine_executor(text, text, boolean, jsonb, bigint),
	public.qorpera_configure_machine_lifecycle(text, integer, integer),
	public.qorpera_machine_text_tail(text, integer),
	public.qorpera_company_machine_binding_text(jsonb),
	public.qorpera_company_machine_placement(uuid),
	public.qorpera_company_machine_placement_reserved(uuid),
	public.qorpera_company_machine_reserved(public.qorpera_company_machines),
	public.qorpera_company_machine_state(public.qorpera_company_machines),
	public.qorpera_company_machine_view(public.qorpera_company_machines),
	public.qorpera_machine_executor_disk_used(text, uuid),
	public.qorpera_company_machine_candidates(bigint, bigint, bigint, text, uuid),
	public.qorpera_place_company_machine(uuid, text),
	public.qorpera_admit_company_machine(uuid, text),
	public.qorpera_end_company_machine_commands(public.qorpera_company_machines, text, jsonb),
	public.qorpera_company_machine_named(uuid, text),
	public.qorpera_native_machine_start(jsonb, text, text, uuid, text),
	public.qorpera_native_machine_manage(jsonb, jsonb),
	public.qorpera_set_company_machine_desired(public.qorpera_company_machines, text, text),
	public.qorpera_close_company_machine(public.qorpera_company_machines),
	public.qorpera_authorize_machine_command(jsonb, jsonb, text, uuid, text, jsonb),
	public.qorpera_company_machine_custody(uuid, text, text, text),
	public.qorpera_list_executor_machines(text, text),
	public.qorpera_admit_executor_machines(text, text, integer),
	public.qorpera_authorize_executor_machine(uuid, text, text, text, text),
	public.qorpera_mark_company_machine_running(uuid, text, text, text, uuid),
	public.qorpera_suspend_company_machine(uuid, text, text, text),
	public.qorpera_release_company_machine(uuid, text, text, text),
	public.qorpera_abandon_machine_executor(text, text),
	public.qorpera_record_company_machine_error(uuid, text, text, text, text),
	public.qorpera_record_company_machine_commands(uuid, text, text, text, uuid, jsonb, boolean),
	public.qorpera_list_company_machines(uuid),
	public.qorpera_list_session_machines(uuid),
	public.qorpera_member_manage_company_machine(uuid, uuid, text),
	public.qorpera_machine_wake_ancestry(public.qorpera_wake_occurrences),
	public.qorpera_machine_event_view(public.qorpera_company_machine_events, integer),
	public.qorpera_machine_event_payload(uuid, uuid[]),
	public.qorpera_machine_revival_stopped(uuid),
	public.qorpera_drain_machine_wakes(integer),
	public.qorpera_machine_run_continuation(public.qorpera_execution_runs, integer)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_configure_machine_executor(text, text, boolean, jsonb, bigint),
	public.qorpera_abandon_machine_executor(text, text),
	public.qorpera_configure_machine_lifecycle(text, integer, integer),
	public.qorpera_native_machine_start(jsonb, text, text, uuid, text),
	public.qorpera_native_machine_manage(jsonb, jsonb),
	public.qorpera_authorize_machine_command(jsonb, jsonb, text, uuid, text, jsonb),
	public.qorpera_list_executor_machines(text, text),
	public.qorpera_admit_executor_machines(text, text, integer),
	public.qorpera_authorize_executor_machine(uuid, text, text, text, text),
	public.qorpera_mark_company_machine_running(uuid, text, text, text, uuid),
	public.qorpera_suspend_company_machine(uuid, text, text, text),
	public.qorpera_release_company_machine(uuid, text, text, text),
	public.qorpera_record_company_machine_error(uuid, text, text, text, text),
	public.qorpera_record_company_machine_commands(uuid, text, text, text, uuid, jsonb, boolean),
	public.qorpera_drain_machine_wakes(integer)
	to service_role;
grant execute on function public.qorpera_list_company_machines(uuid),
	public.qorpera_list_session_machines(uuid),
	public.qorpera_member_manage_company_machine(uuid, uuid, text)
	to authenticated;
