-- Coding machines per member (Step 9 follow-up; Jonas, 2026-09-24).
--
-- Until now every coding session had its own repository VM, kept (stopped)
-- after the session ended together with its allocation and its node demand:
-- a finished session held a place on the node until an operator deleted it.
--
-- Now a member has one coding machine per company environment. It runs the
-- repository commands of all that member's sessions there at once, each in the
-- session's own NAS folders (attached when its turn starts), and nothing else:
-- no model login and no repository credential ever reach it. Its lifecycle:
--
--   * A turn's run authority plans the member's machine, reserves its node
--     demand (waking a sleeping machine re-reserves it) and attaches the
--     session. A full node or a machine being removed defers the session back
--     to the queue instead of failing it (qorpera_defer_coding_session).
--   * With no leased turn on it, the executor stops the machine after the
--     environment's sleep delay; the node demand is then suspended (the office
--     pattern of 20260923060000), so an asleep machine holds no capacity.
--   * After the removal delay asleep, or at once when the deployment policy
--     has moved on, the machine is deleted. Delete custody is irreversible;
--     after the executor's deletion proof its allocation is released (the
--     existing trigger releases the node demand) and a later turn plans a new
--     machine. A released allocation is never revived.
--   * The kept per-session VMs from before this migration become machines of
--     kind 'session': never run again, retired through the same custody as
--     soon as their session has no leased turn. Their NAS folders stay.
--
-- The session's NAS folders (qorpera_coding_storage_volumes) are unchanged and
-- outlive every machine. Each volume gets a stable guest uid, unique among one
-- member's sessions in the environment, so concurrent sessions of a member are
-- separate users inside the machine; volumes made before this migration keep
-- the executor's configured coding uid (guest_uid null).
--
-- One coding session per owner and harness at a time is no longer a rule:
-- model providers enforce their own limits, and node capacity is the only
-- bound (no run counts; Jonas, 2026-09-24).

-- ---------------------------------------------------------------------------
-- 1. Machines
-- ---------------------------------------------------------------------------
create table public.qorpera_coding_machines (
	-- The machine is its capacity allocation: the same id in both ledgers.
	id uuid primary key,
	kind text not null check (kind in ('member','session')),
	profile_id uuid not null references public.qorpera_profiles(id) on delete restrict,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete restrict,
	member_user_id uuid not null references auth.users(id) on delete restrict,
	-- A kept per-session VM from before this migration: the session it belonged to.
	worker_id uuid unique references public.qorpera_runtime_workers(id) on delete restrict,
	owner text not null check (owner ~ '^[A-Za-z0-9_.:-]{1,120}$'),
	machine_id_sha256 text not null check (machine_id_sha256 ~ '^[0-9a-f]{64}$'),
	binding jsonb not null check (jsonb_typeof(binding) = 'object' and pg_column_size(binding) <= 16384),
	-- Pinned by the first run authority from the executor's exact binding text.
	instance_sha256 text check (instance_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	-- Every run authority and every detach touches it: the idle clock.
	last_used_at timestamptz not null default clock_timestamp(),
	-- No new turn starts here: the deployment policy moved on, or a kept per-session VM.
	retire_requested_at timestamptz,
	-- The last stop custody: a suspension needs no run authority since then.
	stop_authorized_at timestamptz,
	-- Delete custody was granted; nothing runs here again.
	removing_at timestamptz,
	removed_at timestamptz,
	-- The executor's last failed step on this machine, until it succeeds; never hidden.
	last_error text check (last_error ~ '^(attach|detach|wake|sleep|delete|release):[A-Z][A-Z0-9_:]{0,119}$'),
	last_error_at timestamptz,
	check ((kind = 'session') = (worker_id is not null)),
	check (kind = 'member' or retire_requested_at is not null),
	check (removed_at is null or removing_at is not null),
	check ((last_error is null) = (last_error_at is null))
);
create unique index qorpera_coding_machines_current on public.qorpera_coding_machines (profile_id, environment_id, member_user_id)
	where kind = 'member' and removed_at is null;
create index qorpera_coding_machines_custody on public.qorpera_coding_machines (owner, machine_id_sha256, created_at)
	where removed_at is null;
alter table public.qorpera_coding_machines enable row level security;
revoke all on public.qorpera_coding_machines from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The capacity ledger learns the machine as a fourth source. A kept per-session
-- allocation keeps its coding_worker_id until it is released.
do $$
begin
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_runtime_machine_allocation_source'
		and conrelid = 'public.qorpera_runtime_machine_allocations'::regclass)) is distinct from
		'CHECK ((((coding_worker_id IS NULL) AND (((run_id IS NOT NULL) AND (runner_id IS NOT NULL) AND (office_id IS NULL) AND (computer_generation IS NULL) AND (login_session_id IS NULL) AND (account_refresh_request_id IS NULL) AND (login_compute_identity_id IS NULL)) OR ((run_id IS NULL) AND (runner_id IS NULL) AND (office_id IS NOT NULL) AND (computer_generation IS NOT NULL) AND (computer_generation > 0) AND (login_session_id IS NULL) AND (account_refresh_request_id IS NULL) AND (login_compute_identity_id IS NULL)) OR ((run_id IS NULL) AND (runner_id IS NULL) AND (office_id IS NULL) AND (computer_generation IS NULL) AND (num_nonnulls(login_session_id, account_refresh_request_id) = 1) AND (login_compute_identity_id IS NOT NULL)))) OR ((coding_worker_id IS NOT NULL) AND (run_id IS NULL) AND (runner_id IS NULL) AND (office_id IS NULL) AND (computer_generation IS NULL) AND (login_session_id IS NULL) AND (account_refresh_request_id IS NULL) AND (login_compute_identity_id IS NULL))))' then
		raise exception 'Machine allocation sources differ from 20260922232000';
	end if;
	if pg_get_constraintdef((select oid from pg_constraint where conname = 'qorpera_runtime_node_demands_suspension_check'
		and conrelid = 'public.qorpera_runtime_node_demands'::regclass)) is distinct from
		'CHECK (((suspended_at IS NULL) OR ((reserved_at IS NOT NULL) AND (provider_kind = ''office''::text))))' then
		raise exception 'Node demand suspension differs from 20260923060000';
	end if;
end
$$;
alter table public.qorpera_runtime_machine_allocations
	add column coding_machine_id uuid unique references public.qorpera_coding_machines(id) on delete restrict,
	drop constraint qorpera_runtime_machine_allocation_source,
	add constraint qorpera_runtime_machine_allocation_source check(
		(coding_worker_id is null and coding_machine_id is null and (
			(run_id is not null and runner_id is not null and office_id is null and computer_generation is null
				and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
			or (run_id is null and runner_id is null and office_id is not null and computer_generation is not null and computer_generation>0
				and login_session_id is null and account_refresh_request_id is null and login_compute_identity_id is null)
			or (run_id is null and runner_id is null and office_id is null and computer_generation is null
				and num_nonnulls(login_session_id,account_refresh_request_id)=1 and login_compute_identity_id is not null)))
		or (num_nonnulls(coding_worker_id, coding_machine_id) = 1 and run_id is null and runner_id is null and office_id is null
			and computer_generation is null and login_session_id is null and account_refresh_request_id is null
			and login_compute_identity_id is null)),
	add constraint qorpera_runtime_machine_allocation_coding_machine check (coding_machine_id is null or coding_machine_id = id);
-- An asleep coding machine gives its node capacity back like a powered-off company computer.
alter table public.qorpera_runtime_node_demands
	drop constraint qorpera_runtime_node_demands_suspension_check,
	add constraint qorpera_runtime_node_demands_suspension_check
		check (suspended_at is null or (reserved_at is not null and provider_kind in ('office','coding')));

-- Idle and removal delays are the environment's configuration, not constants.
alter table public.qorpera_coding_executors
	add column machine_sleep_after_seconds integer not null default 600 check (machine_sleep_after_seconds between 60 and 86400),
	add column machine_remove_after_seconds integer not null default 86400 check (machine_remove_after_seconds between 300 and 31536000);

-- A deferred turn waits in the queue until this time (a full node, a machine being removed).
alter table public.qorpera_coding_sessions add column claim_after timestamptz;

-- Stable guest uids: unique among one member's sessions in an environment, in
-- the range the guest image leaves to them (65536-524287 is unused by systemd).
alter table public.qorpera_coding_storage_volumes
	add column member_user_id uuid references auth.users(id) on delete restrict,
	add column guest_uid integer check (guest_uid between 200000 and 524287);
update public.qorpera_coding_storage_volumes volume set member_user_id = worker.owner_user_id
from public.qorpera_runtime_workers worker where worker.id = volume.worker_id;
alter table public.qorpera_coding_storage_volumes alter column member_user_id set not null;
create unique index qorpera_coding_storage_volumes_guest_uid on public.qorpera_coding_storage_volumes (environment_id, member_user_id, guest_uid)
	where guest_uid is not null;

-- The kept per-session VMs: retired, never run again. Plans whose allocation an
-- operator already released stay history in qorpera_coding_vm_plans only.
insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, worker_id, owner, machine_id_sha256,
	binding, instance_sha256, created_at, last_used_at, retire_requested_at)
select plan.allocation_id, 'session', worker.profile_id, worker.environment_id, worker.owner_user_id, plan.worker_id, plan.owner,
	plan.machine_id_sha256, plan.binding, plan.instance_sha256, plan.created_at, plan.created_at, clock_timestamp()
from public.qorpera_coding_vm_plans plan
join public.qorpera_runtime_workers worker on worker.id = plan.worker_id
join public.qorpera_runtime_machine_allocations allocation on allocation.id = plan.allocation_id
where allocation.released_at is null;

-- ---------------------------------------------------------------------------
-- 2. Kernel integration
-- ---------------------------------------------------------------------------
create function pg_temp.member_machine_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Coding member machine integration differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- The node ledger admits a member machine's allocation as coding demand.
select pg_temp.member_machine_patch('public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)',
	$old$(p_provider_kind='coding' and (v_allocation.coding_worker_id is null or$old$,
	$new$(p_provider_kind='coding' and ((v_allocation.coding_worker_id is null and v_allocation.coding_machine_id is null) or$new$);

-- A member's sessions run side by side on their machine.
select pg_temp.member_machine_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)',
	$old$		-- One coding session per owner and harness at a time: the owner's plan is one person's plan.
		if v_species = 'coding' and exists (select 1 from public.qorpera_runtime_workers worker
			join public.qorpera_coding_sessions session on session.worker_id = worker.id
			where worker.profile_id = v_run.profile_id and worker.owner_user_id = v_owner and worker.state = 'active'
				and session.harness = p_request ->> 'harness') then
			raise exception 'The owner already has a coding session running in %; wait for it or follow it up', p_request ->> 'harness' using errcode = '54000'; end if;
$old$, '');

-- A deferred turn is claimed again only after its wait; the thread sees the
-- first "preparing", not one per retry.
select pg_temp.member_machine_patch('public.qorpera_claim_coding_session(text,integer)',
	$old$		where session.phase in ('queued','input_ready') or$old$,
	$new$		where (session.phase in ('queued','input_ready') and (session.claim_after is null or session.claim_after <= clock_timestamp())) or$new$);
select pg_temp.member_machine_patch('public.qorpera_claim_coding_session(text,integer)',
	$old$			perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'phase', 'executor', jsonb_build_object('phase','preparing','owner',p_owner));$old$,
	$new$			if v_session.claim_after is null then
				perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'phase', 'executor', jsonb_build_object('phase','preparing','owner',p_owner));
			end if;$new$);
select pg_temp.member_machine_patch('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)',
	$old$	update public.qorpera_coding_sessions set phase = 'running', updated_at = clock_timestamp() where worker_id = v_worker.id;$old$,
	$new$	update public.qorpera_coding_sessions set phase = 'running', claim_after = null, updated_at = clock_timestamp() where worker_id = v_worker.id;$new$);
select pg_temp.member_machine_patch('public.qorpera_coding_session_queue(public.qorpera_runtime_workers,text,uuid,text)',
	$old$		finished_at = null, lease_owner = null, lease_token = null, lease_until = null, submission = null, submission_receipt_id = null,$old$,
	$new$		finished_at = null, lease_owner = null, lease_token = null, lease_until = null, submission = null, submission_receipt_id = null, claim_after = null,$new$);
select pg_temp.member_machine_patch('public.qorpera_answer_coding_session(uuid,text,uuid)',
	$old$	update public.qorpera_coding_sessions set phase = 'input_ready', finished_at = null, lease_owner = null, lease_token = null, lease_until = null,$old$,
	$new$	update public.qorpera_coding_sessions set phase = 'input_ready', finished_at = null, lease_owner = null, lease_token = null, lease_until = null, claim_after = null,$new$);

-- A new volume gets the member's next guest uid, serialized per member.
select pg_temp.member_machine_patch('public.qorpera_assert_coding_storage(uuid,text,jsonb,text)',
	$old$		insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding)
		values (v_worker.id, v_worker.environment_id, p_owner, p_machine_id_sha256, 1, v_expected);$old$,
	$new$		perform pg_advisory_xact_lock(hashtextextended('qorpera.coding-guest-uid:' || v_worker.environment_id::text || ':' || v_worker.owner_user_id::text, 0));
		insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding,
			member_user_id, guest_uid)
		values (v_worker.id, v_worker.environment_id, p_owner, p_machine_id_sha256, 1, v_expected, v_worker.owner_user_id,
			(select coalesce(max(volume.guest_uid), 199999) + 1 from public.qorpera_coding_storage_volumes volume
			 where volume.environment_id = v_worker.environment_id and volume.member_user_id = v_worker.owner_user_id));$new$);

-- Only run authority places a session on a machine; progress may echo it, never set it.
select pg_temp.member_machine_patch('public.qorpera_record_coding_progress(uuid,uuid,text,text,integer,jsonb,text,text,uuid,uuid,text)',
	$old$		or (p_files_changed is not null and p_files_changed < 0) then
		raise exception 'Coding progress is invalid' using errcode = '22023'; end if;$old$,
	$new$		or (p_files_changed is not null and p_files_changed < 0)
		or (p_vm_allocation_id is not null and p_vm_allocation_id is distinct from v_session.vm_allocation_id) then
		raise exception 'Coding progress is invalid' using errcode = '22023'; end if;$new$);
select pg_temp.member_machine_patch('public.qorpera_record_coding_progress(uuid,uuid,text,text,integer,jsonb,text,text,uuid,uuid,text)',
	$old$ vm_allocation_id = coalesce(vm_allocation_id, p_vm_allocation_id),$old$, '');

-- The per-session VM authority is replaced by the machine functions below.
drop function public.qorpera_authorize_coding_machine(uuid, uuid, text, text, text);
drop function public.qorpera_authorize_coding_cleanup(uuid, text, text, text);
drop function public.qorpera_describe_coding_cleanup(uuid, text, text);

-- ---------------------------------------------------------------------------
-- 3. Machine authority
-- ---------------------------------------------------------------------------
-- A leased turn runs on this machine now. Internal: callers hold the machine row.
create function public.qorpera_coding_machine_live(p_machine public.qorpera_coding_machines)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_coding_sessions session where session.vm_allocation_id = p_machine.id
		and session.phase in ('preparing','running','publishing') and session.lease_until > clock_timestamp())
$$;

-- The machine a leased turn of this member runs on: the current one, or a new
-- plan built from the environment's VM policy. A machine whose policy moved on
-- takes no new turn; the turn waits until it has been removed.
create function public.qorpera_plan_coding_machine(p_worker_id uuid, p_lease_token uuid, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_executor public.qorpera_coding_executors%rowtype; v_machine public.qorpera_coding_machines%rowtype; v_identity jsonb;
begin
	if coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	select * into v_executor from public.qorpera_coding_executors
	where environment_id = v_worker.environment_id and owner = v_session.lease_owner and enabled for share;
	if v_executor.vm_policy is null or v_executor.nas_machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Coding machine deployment policy unavailable' using errcode = '42501'; end if;
	perform pg_advisory_xact_lock(hashtextextended('qorpera.coding-machine:' || v_worker.environment_id::text || ':' || v_worker.owner_user_id::text, 0));
	select * into v_machine from public.qorpera_coding_machines where profile_id = v_worker.profile_id
		and environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id and kind = 'member' and removed_at is null
	for update;
	-- Released through the general machine release (an operator's deletion proof): closed here too.
	if v_machine.id is not null and exists (select 1 from public.qorpera_runtime_machine_allocations
		where id = v_machine.id and released_at is not null) then
		update public.qorpera_coding_machines set removing_at = coalesce(removing_at, clock_timestamp()), removed_at = clock_timestamp()
		where id = v_machine.id;
		v_machine := null;
	end if;
	if v_machine.id is null then
		v_machine.id := extensions.gen_random_uuid();
		insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
		values (v_machine.id, 'member', v_worker.profile_id, v_worker.environment_id, v_worker.owner_user_id, v_session.lease_owner,
			p_machine_id_sha256, jsonb_build_object('schema','qorpera.lxd-coding-machine/v1','machineId',v_machine.id,
				'companyId',v_worker.profile_id,'environmentId',v_worker.environment_id,'memberUserId',v_worker.owner_user_id) || v_executor.vm_policy)
		returning * into v_machine;
	elsif v_machine.owner <> v_session.lease_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256 then
		raise exception 'Coding machine belongs to another executor' using errcode = '42501';
	elsif v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> v_executor.vm_policy then
		if v_machine.instance_sha256 is null then
			-- Never admitted: nothing physical exists yet, so the plan simply follows the policy.
			update public.qorpera_coding_machines set binding = (binding - array(select jsonb_object_keys(v_executor.vm_policy))) || v_executor.vm_policy
			where id = v_machine.id returning * into v_machine;
		elsif v_machine.retire_requested_at is null then
			update public.qorpera_coding_machines set retire_requested_at = clock_timestamp() where id = v_machine.id returning * into v_machine;
		end if;
	end if;
	if v_machine.retire_requested_at is not null or v_machine.removing_at is not null then
		return jsonb_build_object('state','refused','reason','MACHINE_RETIRING','machineId',v_machine.id); end if;
	return jsonb_build_object('schema','qorpera.coding-machine-plan/v1','state','planned','machineId',v_machine.id,'binding',v_machine.binding);
end
$$;

-- Run authority, re-fetched before every LXD effect a turn causes (create,
-- start, attach, guest steps, commands): the live session lease, this
-- member's current machine, its exact binding, the session's pinned NAS
-- volume, the capacity allocation and a fresh node reservation (which wakes an
-- asleep machine). Valid for seconds.
create function public.qorpera_authorize_coding_machine_run(p_worker_id uuid, p_lease_token uuid, p_binding_text text, p_storage jsonb,
	p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_machine public.qorpera_coding_machines%rowtype; v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_volume public.qorpera_coding_storage_volumes%rowtype; v_binding jsonb; v_digest text; v_node jsonb; v_valid integer; v_machine_id uuid;
begin
	if octet_length(coalesce(p_binding_text,'')) not between 2 and 16384 or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	v_binding := p_binding_text::jsonb;
	v_digest := encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex');
	begin v_machine_id := (v_binding ->> 'machineId')::uuid;
	exception when invalid_text_representation then raise exception 'Coding machine scope differs' using errcode = '42501'; end;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id for update;
	select * into v_machine from public.qorpera_coding_machines where id = v_machine_id for update;
	if v_machine.id is null or v_machine.kind <> 'member' or v_machine.profile_id <> v_worker.profile_id
		or v_machine.environment_id <> v_worker.environment_id or v_machine.member_user_id <> v_worker.owner_user_id
		or v_machine.owner <> v_session.lease_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256
		or v_machine.binding <> v_binding or coalesce(v_machine.instance_sha256, v_digest) <> v_digest then
		raise exception 'Coding machine scope differs' using errcode = '42501'; end if;
	if v_machine.removing_at is not null then return '{"state":"refused","reason":"MACHINE_RETIRING"}'::jsonb; end if;
	-- A turn not yet begun waits for a machine whose policy moved on; a turn already running there finishes there.
	if v_machine.retire_requested_at is not null and v_worker.occurrence_id is null then
		return '{"state":"refused","reason":"MACHINE_RETIRING"}'::jsonb; end if;
	if v_session.vm_allocation_id is distinct from v_machine.id and v_session.phase <> 'preparing' then
		raise exception 'Coding session runs on another machine' using errcode = '42501'; end if;
	perform public.qorpera_assert_coding_storage(v_worker.id, v_session.lease_owner, p_storage, p_machine_id_sha256);
	select * into strict v_volume from public.qorpera_coding_storage_volumes where worker_id = v_worker.id;
	-- Volumes from before per-member machines share one guest uid: never two of them at once on a machine.
	if v_volume.guest_uid is null and exists (select 1 from public.qorpera_coding_sessions other
		join public.qorpera_coding_storage_volumes other_volume on other_volume.worker_id = other.worker_id
		where other.vm_allocation_id = v_machine.id and other.worker_id <> v_worker.id and other_volume.guest_uid is null
			and other.phase in ('preparing','running','publishing') and other.lease_until > clock_timestamp()) then
		return '{"state":"refused","reason":"LEGACY_SESSION_BUSY"}'::jsonb; end if;
	-- A session moves to this machine only once the machine it ran on before sleeps or is gone: its
	-- folders may still be attached there (a kept per-session VM, or a turn whose executor died).
	if v_session.vm_allocation_id is distinct from v_machine.id and exists (select 1 from public.qorpera_coding_machines previous
		join public.qorpera_runtime_node_demands demand on demand.allocation_id = previous.id
		where previous.id = v_session.vm_allocation_id and previous.removed_at is null
			and demand.reserved_at is not null and demand.released_at is null and demand.suspended_at is null) then
		return '{"state":"refused","reason":"PREVIOUS_MACHINE_AWAKE"}'::jsonb; end if;
	if v_machine.instance_sha256 is null then
		update public.qorpera_coding_machines set instance_sha256 = v_digest where id = v_machine.id returning * into v_machine; end if;
	select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_machine.id for update;
	if found then
		if v_allocation.profile_id <> v_machine.profile_id or v_allocation.coding_machine_id is distinct from v_machine.id
			or v_allocation.provider_adapter <> v_binding ->> 'providerId' or v_allocation.instance_sha256 <> v_digest
			or v_allocation.released_at is not null then
			raise exception 'Coding machine allocation cannot be rebound or revived' using errcode = '42501'; end if;
	else
		insert into public.qorpera_runtime_machine_allocations(id, profile_id, coding_machine_id, provider_adapter, instance_sha256)
		values (v_machine.id, v_machine.profile_id, v_machine.id, v_binding ->> 'providerId', v_digest);
	end if;
	v_node := public.qorpera_reserve_runtime_node_machine(v_machine.id, 'coding', v_binding ->> 'providerId', v_binding ->> 'providerPolicySha256',
		v_digest, p_machine_id_sha256, (v_binding ->> 'cpus')::bigint * 1000, (v_binding ->> 'memoryBytes')::bigint);
	if v_node ->> 'state' <> 'reserved' then return v_node; end if;
	if v_session.vm_allocation_id is distinct from v_machine.id then
		update public.qorpera_coding_sessions set vm_allocation_id = v_machine.id, updated_at = clock_timestamp() where worker_id = v_worker.id;
	end if;
	update public.qorpera_coding_machines set last_used_at = clock_timestamp() where id = v_machine.id;
	v_valid := least((v_node ->> 'validForMs')::integer, floor(extract(epoch from v_session.lease_until - clock_timestamp()) * 1000)::integer);
	if v_valid < 1 then raise exception 'Coding lease expired' using errcode = '42501'; end if;
	return jsonb_build_object('schema','qorpera.coding-machine-admission/v1','machineId',v_machine.id,'workerId',v_worker.id,
		'instanceSha256',v_digest,'intent','run','guestUid',v_volume.guest_uid,'validForMs',v_valid,
		'nodeId',v_node -> 'nodeId','nodeVersion',v_node -> 'nodeVersion');
end
$$;

-- Custody of a machine belongs to the executor that planned it, on the node
-- that planned it, lease or no lease. Internal: locks and checks the machine.
create function public.qorpera_coding_machine_custody(p_machine_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns public.qorpera_coding_machines language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_machine_id is null or octet_length(coalesce(p_binding_text,'')) not between 2 and 16384
		or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	select * into v_machine from public.qorpera_coding_machines where id = p_machine_id for update;
	if v_machine.id is null or v_machine.owner <> p_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256
		or v_machine.binding <> p_binding_text::jsonb
		or v_machine.instance_sha256 is distinct from encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex') then
		raise exception 'Coding machine custody differs' using errcode = '42501'; end if;
	return v_machine;
end
$$;

-- Stop, detach and delete custody, valid for seconds. Stop (the machine goes
-- to sleep): no leased turn on it. Detach (one session's folders): that
-- session's turn has ended, or the caller holds its lease. Delete: no leased
-- turn and the node demand suspended or never reserved; granting it is
-- irreversible, and no run authority is given for the machine afterwards.
create function public.qorpera_authorize_coding_machine_custody(p_machine_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text,
	p_intent text, p_worker_id uuid default null, p_lease_token uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype; v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_demand public.qorpera_runtime_node_demands%rowtype; v_node public.qorpera_runtime_nodes%rowtype; v_session public.qorpera_coding_sessions%rowtype;
	v_executor public.qorpera_coding_executors%rowtype;
begin
	if p_intent is null or p_intent not in ('stop','detach','delete') or ((p_intent = 'detach') <> (p_worker_id is not null))
		or (p_intent <> 'detach' and p_lease_token is not null) then
		raise exception 'Coding machine custody input invalid' using errcode = '22023'; end if;
	v_machine := public.qorpera_coding_machine_custody(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if v_machine.removed_at is not null then raise exception 'Coding machine was removed' using errcode = '42501'; end if;
	select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_machine.id for share;
	select * into v_demand from public.qorpera_runtime_node_demands where allocation_id = v_machine.id and provider_kind = 'coding'
		and provider_id = v_allocation.provider_adapter and policy_sha256 = v_machine.binding ->> 'providerPolicySha256';
	select * into v_node from public.qorpera_runtime_nodes where id = v_demand.node_id;
	if v_allocation.id is null or v_allocation.released_at is not null or v_allocation.instance_sha256 <> v_machine.instance_sha256
		or (v_machine.kind = 'member' and v_allocation.coding_machine_id is distinct from v_machine.id)
		or (v_machine.kind = 'session' and v_allocation.coding_worker_id is distinct from v_machine.worker_id)
		or v_demand.allocation_id is null or v_demand.released_at is not null or v_node.machine_id_sha256 is distinct from p_machine_id_sha256 then
		raise exception 'Coding machine node custody differs' using errcode = '42501'; end if;
	if p_intent = 'detach' then
		select * into v_session from public.qorpera_coding_sessions where worker_id = p_worker_id for update;
		if v_machine.kind <> 'member' or v_session.worker_id is null or v_session.vm_allocation_id is distinct from v_machine.id then
			raise exception 'Coding session is not on this machine' using errcode = '42501'; end if;
		if v_session.phase in ('preparing','running','publishing') and v_session.lease_until > clock_timestamp()
			and v_session.lease_token is distinct from p_lease_token then
			return '{"state":"refused","reason":"SESSION_IN_USE"}'::jsonb; end if;
		update public.qorpera_coding_machines set last_used_at = clock_timestamp() where id = v_machine.id;
	elsif public.qorpera_coding_machine_live(v_machine) then
		return '{"state":"refused","reason":"MACHINE_IN_USE"}'::jsonb;
	elsif p_intent = 'stop' then
		update public.qorpera_coding_machines set stop_authorized_at = clock_timestamp() where id = v_machine.id;
	else
		if v_demand.reserved_at is not null and v_demand.suspended_at is null then
			return '{"state":"refused","reason":"MACHINE_AWAKE"}'::jsonb; end if;
		-- A current member machine is removed only after the environment's removal delay asleep.
		select * into v_executor from public.qorpera_coding_executors where environment_id = v_machine.environment_id and owner = v_machine.owner;
		if v_machine.kind = 'member' and v_machine.retire_requested_at is null and v_executor.vm_policy is not null
			and v_machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] = v_executor.vm_policy
			and coalesce(v_demand.suspended_at, v_machine.last_used_at) > clock_timestamp() - make_interval(secs => v_executor.machine_remove_after_seconds) then
			return '{"state":"refused","reason":"MACHINE_NOT_DUE"}'::jsonb; end if;
		update public.qorpera_coding_machines set removing_at = coalesce(removing_at, clock_timestamp()) where id = v_machine.id;
	end if;
	return jsonb_build_object('schema','qorpera.coding-machine-admission/v1','machineId',v_machine.id,'workerId',p_worker_id,
		'instanceSha256',v_machine.instance_sha256,'intent',p_intent,'guestUid',null,'validForMs',5000,
		'nodeId',v_node.id,'nodeVersion',v_node.version);
end
$$;

-- After a confirmed stop: the node demand keeps its row and placement but no
-- longer counts. The next run authority re-reserves it or refuses on a full node.
create function public.qorpera_suspend_coding_machine(p_machine_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype; v_demand public.qorpera_runtime_node_demands%rowtype;
begin
	v_machine := public.qorpera_coding_machine_custody(p_machine_id, p_owner, p_binding_text, p_machine_id_sha256);
	if v_machine.removed_at is not null then raise exception 'Coding machine was removed' using errcode = '42501'; end if;
	if public.qorpera_coding_machine_live(v_machine) then return '{"state":"kept","reason":"MACHINE_IN_USE"}'::jsonb; end if;
	-- The stop that preceded this was authorized with no turn on the machine, and none has used it since.
	if v_machine.stop_authorized_at is null or v_machine.last_used_at > v_machine.stop_authorized_at then
		return '{"state":"kept","reason":"MACHINE_USED_SINCE_STOP"}'::jsonb; end if;
	-- Lock order as in reservation: profile fence -> company allocation -> node -> demand.
	perform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);
	perform 1 from public.qorpera_runtime_machine_allocations where id = v_machine.id and released_at is null for update;
	if not found then raise exception 'Coding machine allocation unavailable' using errcode = '42501'; end if;
	perform 1 from public.qorpera_runtime_nodes node join public.qorpera_runtime_node_demands demand on demand.node_id = node.id
	where demand.allocation_id = v_machine.id and node.machine_id_sha256 = p_machine_id_sha256 for update of node;
	if not found then raise exception 'Coding machine node custody differs' using errcode = '42501'; end if;
	select * into strict v_demand from public.qorpera_runtime_node_demands where allocation_id = v_machine.id for update;
	if v_demand.provider_kind <> 'coding' or v_demand.reserved_at is null or v_demand.released_at is not null then
		return '{"state":"kept","reason":"NOT_RESERVED"}'::jsonb; end if;
	if v_demand.suspended_at is null then
		update public.qorpera_runtime_node_demands set suspended_at = clock_timestamp() where allocation_id = v_machine.id returning * into v_demand;
	end if;
	return jsonb_build_object('schema','qorpera.coding-machine-sleep/v1','state','suspended','machineId',v_machine.id,'asleepSince',v_demand.suspended_at);
end
$$;

-- The executor's deletion proof (its journal holds the accepted LXD delete and
-- LXD reports no such instance) releases the allocation; the node demand
-- follows through the existing trigger. A machine whose node demand was never
-- reserved never got a run receipt, so no VM can exist: it closes without
-- delete custody, as does a plan never admitted at all, and one whose
-- allocation the general machine release already released. Repeating a
-- release answers the same.
create function public.qorpera_release_coding_machine(p_machine_id uuid, p_owner text, p_binding_text text, p_machine_id_sha256 text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_machine public.qorpera_coding_machines%rowtype; v_allocation public.qorpera_runtime_machine_allocations%rowtype;
	v_reserved boolean;
begin
	if auth.role() is distinct from 'service_role' or p_machine_id is null or octet_length(coalesce(p_binding_text,'')) not between 2 and 16384
		or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$' or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	select * into v_machine from public.qorpera_coding_machines where id = p_machine_id for update;
	if v_machine.id is null or v_machine.owner <> p_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256
		or v_machine.binding <> p_binding_text::jsonb or (v_machine.instance_sha256 is not null
			and v_machine.instance_sha256 <> encode(extensions.digest(convert_to(p_binding_text,'utf8'),'sha256'),'hex')) then
		raise exception 'Coding machine custody differs' using errcode = '42501'; end if;
	if v_machine.removed_at is null then
		v_reserved := exists (select 1 from public.qorpera_runtime_node_demands where allocation_id = v_machine.id and reserved_at is not null);
		select * into v_allocation from public.qorpera_runtime_machine_allocations where id = v_machine.id;
		if v_machine.instance_sha256 is null then
			if v_allocation.id is not null then
				raise exception 'Coding machine allocation differs' using errcode = '42501'; end if;
		elsif v_allocation.released_at is not null then
			-- Already released through the general machine release with its own deletion proof.
			null;
		elsif v_machine.removing_at is null and v_reserved then
			raise exception 'Coding machine deletion was not authorized' using errcode = '42501';
		else
			if public.qorpera_coding_machine_live(v_machine) then raise exception 'Coding machine is in use' using errcode = '55000'; end if;
			perform public.qorpera_lock_profile_gc_fence(v_machine.profile_id);
			select * into strict v_allocation from public.qorpera_runtime_machine_allocations where id = v_machine.id for update;
			if v_allocation.instance_sha256 <> v_machine.instance_sha256
				or (v_machine.kind = 'member' and v_allocation.coding_machine_id is distinct from v_machine.id)
				or (v_machine.kind = 'session' and v_allocation.coding_worker_id is distinct from v_machine.worker_id) then
				raise exception 'Coding machine allocation differs' using errcode = '42501'; end if;
			update public.qorpera_runtime_machine_allocations set released_at = coalesce(released_at, clock_timestamp()) where id = v_machine.id;
		end if;
		-- Sessions keep pointing at it as the machine they last ran on; a removed machine holds nothing.
		update public.qorpera_coding_machines set removing_at = coalesce(removing_at, clock_timestamp()), removed_at = clock_timestamp(),
			last_error = null, last_error_at = null
		where id = v_machine.id returning * into v_machine;
	end if;
	return jsonb_build_object('schema','qorpera.coding-machine-release/v1','state','released','machineId',v_machine.id,
		'instanceSha256',v_machine.instance_sha256,'removedAt',v_machine.removed_at);
end
$$;

-- A failed stop, delete or release stays visible on the machine until the step
-- succeeds; a null code clears it.
create function public.qorpera_record_coding_machine_error(p_machine_id uuid, p_owner text, p_machine_id_sha256 text, p_stage text, p_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or p_stage is null or p_stage not in ('attach','detach','wake','sleep','delete','release')
		or (p_code is not null and p_code !~ '^[A-Z][A-Z0-9_:]{0,119}$') then
		raise exception 'Coding machine error invalid' using errcode = '22023'; end if;
	update public.qorpera_coding_machines set last_error = case when p_code is null then null else p_stage || ':' || p_code end,
		last_error_at = case when p_code is null then null else clock_timestamp() end
	where id = p_machine_id and owner = p_owner and machine_id_sha256 = p_machine_id_sha256 and removed_at is null
		and (p_code is not null or last_error like p_stage || ':%');
end
$$;

-- The executor's housekeeping list: all its machines on this node that exist,
-- with what is due. The executor acts on it; every effect re-checks its own
-- custody (the removal delay is enforced there too; the sleep delay is the
-- executor's to keep, since sleeping early only costs a boot).
create function public.qorpera_list_coding_machines(p_owner text, p_machine_id_sha256 text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' or coalesce(p_owner,'') !~ '^[A-Za-z0-9_.:-]{1,120}$'
		or coalesce(p_machine_id_sha256,'') !~ '^[0-9a-f]{64}$' then
		raise exception 'Coding machine custody required' using errcode = '42501'; end if;
	return coalesce((select jsonb_agg(entry order by entry ->> 'createdAt', entry ->> 'machineId') from (
		select jsonb_build_object('schema','qorpera.coding-machine-state/v1','machineId',machine.id,'kind',machine.kind,
			'workerId',machine.worker_id,'binding',machine.binding,'instanceSha256',machine.instance_sha256,'live',state.live,
			'reserved',state.reserved,'asleepSince',demand.suspended_at,'removing',machine.removing_at is not null,
			'superseded',state.superseded,'released',state.released,'lastUsedAt',machine.last_used_at,'createdAt',machine.created_at,
			'lastError',machine.last_error,'lastErrorAt',machine.last_error_at,
			'sleepDue',machine.kind = 'member' and not state.live and state.reserved and not state.superseded
				and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.machine_sleep_after_seconds),
			'removeDue',not state.live and (machine.removing_at is not null or state.superseded or state.released
				or (demand.suspended_at is not null and demand.suspended_at <= clock_timestamp() - make_interval(secs => executor.machine_remove_after_seconds))
				or (not state.reserved and demand.suspended_at is null
					and machine.last_used_at <= clock_timestamp() - make_interval(secs => executor.machine_remove_after_seconds)))) entry
		from public.qorpera_coding_machines machine
		left join public.qorpera_coding_executors executor on executor.environment_id = machine.environment_id and executor.owner = machine.owner
		left join public.qorpera_runtime_node_demands demand on demand.allocation_id = machine.id and demand.released_at is null
		left join public.qorpera_runtime_machine_allocations allocation on allocation.id = machine.id
		cross join lateral (select public.qorpera_coding_machine_live(machine) as live,
			allocation.released_at is not null as released,
			demand.reserved_at is not null and demand.suspended_at is null as reserved,
			machine.kind = 'session' or machine.retire_requested_at is not null or executor.vm_policy is null
				or machine.binding - array['schema','machineId','companyId','environmentId','memberUserId'] <> executor.vm_policy as superseded) state
		where machine.owner = p_owner and machine.machine_id_sha256 = p_machine_id_sha256 and machine.removed_at is null) listed), '[]'::jsonb);
end
$$;

-- A turn that cannot have its machine yet (a full node, a machine being
-- removed) goes back to the queue with a visible step instead of failing.
create function public.qorpera_defer_coding_session(p_worker_id uuid, p_lease_token uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.qorpera_coding_sessions%rowtype; v_worker public.qorpera_runtime_workers%rowtype;
	v_step constant text := 'Waiting for a coding machine'; v_waiting boolean;
begin
	if coalesce(p_reason,'') !~ '^[A-Z][A-Z0-9_]{0,63}$' then raise exception 'Coding deferral invalid' using errcode = '22023'; end if;
	v_session := public.qorpera_coding_leased_session(p_worker_id, p_lease_token);
	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	if v_session.phase <> 'preparing' or v_worker.occurrence_id is not null then
		raise exception 'Only a turn that has not begun can wait for its machine' using errcode = '55000'; end if;
	v_waiting := v_session.last_step is not distinct from v_step;
	update public.qorpera_coding_sessions set phase = case when v_worker.sequence = 1 then 'queued' else 'input_ready' end,
		lease_owner = null, lease_token = null, lease_until = null, claim_after = clock_timestamp() + interval '15 seconds',
		last_step = v_step, updated_at = clock_timestamp()
	where worker_id = v_worker.id returning * into v_session;
	-- One step in the thread for the whole wait, not one per retry.
	if not v_waiting then
		perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'executor', jsonb_build_object('text', v_step, 'reason', p_reason));
	end if;
	return public.qorpera_coding_session_view(v_session, v_worker);
end
$$;

create function public.qorpera_configure_coding_machine_lifecycle(p_environment_id uuid, p_owner text, p_sleep_after_seconds integer,
	p_remove_after_seconds integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
	if auth.role() is distinct from 'service_role' then raise exception 'Coding machine operator authority required' using errcode = '42501'; end if;
	update public.qorpera_coding_executors set machine_sleep_after_seconds = p_sleep_after_seconds, machine_remove_after_seconds = p_remove_after_seconds
	where environment_id = p_environment_id and owner = p_owner;
	if not found then raise exception 'Coding executor unavailable' using errcode = '42501'; end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.qorpera_coding_machine_live(public.qorpera_coding_machines),
	public.qorpera_plan_coding_machine(uuid, uuid, text),
	public.qorpera_authorize_coding_machine_run(uuid, uuid, text, jsonb, text),
	public.qorpera_coding_machine_custody(uuid, text, text, text),
	public.qorpera_authorize_coding_machine_custody(uuid, text, text, text, text, uuid, uuid),
	public.qorpera_suspend_coding_machine(uuid, text, text, text),
	public.qorpera_release_coding_machine(uuid, text, text, text),
	public.qorpera_record_coding_machine_error(uuid, text, text, text, text),
	public.qorpera_list_coding_machines(text, text),
	public.qorpera_defer_coding_session(uuid, uuid, text),
	public.qorpera_configure_coding_machine_lifecycle(uuid, text, integer, integer)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_plan_coding_machine(uuid, uuid, text),
	public.qorpera_authorize_coding_machine_run(uuid, uuid, text, jsonb, text),
	public.qorpera_authorize_coding_machine_custody(uuid, text, text, text, text, uuid, uuid),
	public.qorpera_suspend_coding_machine(uuid, text, text, text),
	public.qorpera_release_coding_machine(uuid, text, text, text),
	public.qorpera_record_coding_machine_error(uuid, text, text, text, text),
	public.qorpera_list_coding_machines(text, text),
	public.qorpera_defer_coding_session(uuid, uuid, text),
	public.qorpera_configure_coding_machine_lifecycle(uuid, text, integer, integer)
	to service_role;
