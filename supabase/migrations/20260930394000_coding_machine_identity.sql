-- 20260930394000: step 5a, the coding machine's identity (deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md, "Views and
-- machines" and "Commands and sessions"). A coding machine holds one member's sessions for one coding agent, one
-- repository and one setup digest, so every view on it has the same authority. Patched bodies are patched in place from
-- their live text, so their headers, grants and other migrations' changes stay; each anchor must occur exactly once.
-- 1. qorpera_coding_machines gets staff_agent_id, repository (the session's GitHub <owner>/<name>, in lower case, as
--    GitHub's names are), setup_digest and number (the machine's place when one is full, 5k; 1 until then), and
--    qorpera_coding_machines_current is unique over them with the company, environment and member. A live member
--    machine from before has neither agent nor repository: it is asked to retire, as a policy change asks.
-- 2. qorpera_plan_coding_machine takes p_setup_digest; until 5h computes it, none is the empty setup's (the SHA-256 of no
--    bytes). A session plans on its own machine while that one is live, so a changed setup moves only the member's next
--    new session; otherwise on the member's machine for the session's agent, repository and digest. The three-argument
--    plan goes: PostgREST resolves a call by its named parameters, and the executor's three still reach the new one.
-- 3. qorpera_authorize_coding_machine_run admits a turn only on a machine of its session's agent and repository, and
--    allocates the session's uid (200000-524287, unique among the member's sessions in the environment) in the new
--    qorpera_coding_session_uids instead of on its NAS volume; qorpera_assert_coding_storage no longer writes one. The
--    refusal for volumes from before per-member machines (LEGACY_SESSION_BUSY) goes: every admitted session has a uid.
-- 4. qorpera_coding_member_has_open_session asks for the machine's own sessions: a member's session on another of their
--    machines no longer keeps this one.
-- Every patched body names this migration (20260930394000), and every earlier marker in it stays.

set local lock_timeout = '3s';

-- Applies each (old, new) pair in turn, each old text exactly once, then runs the result.
create function pg_temp.s5a_patch(p_target regprocedure, p_edits text[]) returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target); v_found integer;
begin
	for i in 1..cardinality(p_edits) / 2 loop
		v_found := (length(v_definition) - length(replace(v_definition, p_edits[2 * i - 1], ''))) / length(p_edits[2 * i - 1]);
		if v_found <> 1 then
			raise exception 'Step 5a anchor found % time(s) in %, expected 1: %', v_found, p_target, left(p_edits[2 * i - 1], 80); end if;
		v_definition := replace(v_definition, p_edits[2 * i - 1], p_edits[2 * i]);
	end loop;
	execute v_definition;
end $$;

-- 1. The machine's agent, repository, setup digest and place. ---------------------------------------------------------

alter table public.qorpera_coding_machines
	add column staff_agent_id uuid,
	add column repository text check (repository ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?/[a-z0-9_][a-z0-9_.-]{0,99}$'),
	add column setup_digest text check (setup_digest ~ '^[0-9a-f]{64}$'),
	add column number integer not null default 1 check (number >= 1);
update public.qorpera_coding_machines set retire_requested_at = coalesce(retire_requested_at, clock_timestamp())
where kind = 'member' and staff_agent_id is null and removed_at is null;
drop index public.qorpera_coding_machines_current;
create unique index qorpera_coding_machines_current on public.qorpera_coding_machines
	(profile_id, environment_id, member_user_id, staff_agent_id, repository, setup_digest, number) where kind = 'member' and removed_at is null;

-- Each session's uid on its machine, allocated at its first run authority.
create table public.qorpera_coding_session_uids (
	worker_id uuid primary key references public.qorpera_coding_sessions(worker_id) on delete cascade,
	environment_id uuid not null,
	member_user_id uuid not null,
	guest_uid integer not null check (guest_uid between 200000 and 524287),
	created_at timestamptz not null default clock_timestamp(),
	unique (environment_id, member_user_id, guest_uid)
);
alter table public.qorpera_coding_session_uids enable row level security;
revoke all on public.qorpera_coding_session_uids from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. The plan picks the machine of the session's agent, repository and setup digest. -----------------------------------

select pg_temp.s5a_patch('public.qorpera_plan_coding_machine(uuid,uuid,text)'::regprocedure, array[
$old$qorpera_plan_coding_machine(p_worker_id uuid, p_lease_token uuid, p_machine_id_sha256 text)$old$,
$new$qorpera_plan_coding_machine(p_worker_id uuid, p_lease_token uuid, p_machine_id_sha256 text, p_setup_digest text DEFAULT NULL::text)$new$,
$old$	v_binding text; v_node jsonb; v_result jsonb;
$old$,
$new$	v_binding text; v_node jsonb; v_result jsonb; v_repository text; v_setup_digest text;
$new$,
$old$	if coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
$old$,
$new$	if coalesce(p_machine_id_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	-- 20260930394000 (step 5a): until 5h computes the setup digest, a plan without one is the empty setup's.
	if p_setup_digest !~ '^[0-9a-f]{64}$' then raise exception 'Coding machine input invalid' using errcode = '22023'; end if;
	v_setup_digest := coalesce(p_setup_digest, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
$new$,
$old$	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
$old$,
$new$	select * into strict v_worker from public.qorpera_runtime_workers where id = v_session.worker_id;
	v_repository := lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name'));
$new$,
$old$	select * into v_machine from public.qorpera_coding_machines where profile_id = v_worker.profile_id
		and environment_id = v_worker.environment_id and member_user_id = v_worker.owner_user_id and kind = 'member' and removed_at is null for update;
	if v_machine.id is not null and exists (select 1 from public.qorpera_runtime_machine_allocations where id = v_machine.id and released_at is not null) then
		update public.qorpera_coding_machines set removing_at = coalesce(removing_at, clock_timestamp()), removed_at = clock_timestamp() where id = v_machine.id;
		v_machine := null;
	end if;
$old$,
$new$	-- 20260930394000 (step 5a): a machine per member, agent, repository and setup digest. The session's own machine
	-- comes first while it is live, so a changed setup moves only the member's next new session. A machine whose
	-- allocation was released is marked removed first.
	update public.qorpera_coding_machines machine set removing_at = coalesce(machine.removing_at, clock_timestamp()), removed_at = clock_timestamp()
	where machine.profile_id = v_worker.profile_id and machine.environment_id = v_worker.environment_id
		and machine.member_user_id = v_worker.owner_user_id and machine.staff_agent_id = v_worker.staff_agent_id
		and machine.repository = v_repository and machine.kind = 'member' and machine.removed_at is null
		and (machine.id = v_session.vm_allocation_id or (machine.setup_digest = v_setup_digest and machine.number = 1))
		and exists (select 1 from public.qorpera_runtime_machine_allocations allocation
			where allocation.id = machine.id and allocation.released_at is not null);
	select * into v_machine from public.qorpera_coding_machines machine
	where machine.profile_id = v_worker.profile_id and machine.environment_id = v_worker.environment_id
		and machine.member_user_id = v_worker.owner_user_id and machine.staff_agent_id = v_worker.staff_agent_id
		and machine.repository = v_repository and machine.kind = 'member' and machine.removed_at is null
		and (machine.id = v_session.vm_allocation_id or (machine.setup_digest = v_setup_digest and machine.number = 1))
	order by machine.id is distinct from v_session.vm_allocation_id limit 1 for update;
$new$,
$old$				insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding)
$old$,
$new$				-- 20260930394000 (step 5a): the machine's agent, repository, setup digest and place.
				insert into public.qorpera_coding_machines(id, kind, profile_id, environment_id, member_user_id, owner, machine_id_sha256, binding,
					staff_agent_id, repository, setup_digest, number)
$new$,
$old$'memberUserId',v_worker.owner_user_id) || v_executor.vm_policy)
$old$,
$new$'memberUserId',v_worker.owner_user_id) || v_executor.vm_policy,
					v_worker.staff_agent_id, v_repository, v_setup_digest, 1)
$new$]);
drop function public.qorpera_plan_coding_machine(uuid, uuid, text);
revoke all on function public.qorpera_plan_coding_machine(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_plan_coding_machine(uuid, uuid, text, text) to service_role;

-- 3. A turn runs only on its session's agent and repository, as the session's own uid. ---------------------------------

select pg_temp.s5a_patch('public.qorpera_authorize_coding_machine_run(uuid,uuid,text,jsonb,text)'::regprocedure, array[
$old$	v_volume public.qorpera_coding_storage_volumes%rowtype; v_binding jsonb;$old$,
$new$	v_guest_uid integer; v_binding jsonb;$new$,
$old$		or v_machine.owner <> v_session.lease_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256 then
$old$,
$new$		or v_machine.owner <> v_session.lease_owner or v_machine.machine_id_sha256 <> p_machine_id_sha256
		-- 20260930394000 (step 5a): only a machine of the session's agent and repository.
		or v_machine.staff_agent_id is distinct from v_worker.staff_agent_id
		or v_machine.repository is distinct from lower((v_session.repository ->> 'owner') || '/' || (v_session.repository ->> 'name')) then
$new$,
$old$	select * into strict v_volume from public.qorpera_coding_storage_volumes where worker_id = v_worker.id;
	-- Volumes from before per-member machines share one guest uid: never two of them at once on a machine.
	if v_volume.guest_uid is null and exists (select 1 from public.qorpera_coding_sessions other
		join public.qorpera_coding_storage_volumes other_volume on other_volume.worker_id = other.worker_id
		where other.vm_allocation_id = v_machine.id and other.worker_id <> v_worker.id and other_volume.guest_uid is null
			and other.phase in ('preparing','running','publishing') and other.lease_until > clock_timestamp()) then
		return '{"state":"refused","reason":"LEGACY_SESSION_BUSY"}'::jsonb; end if;
$old$,
$new$	-- 20260930394000 (step 5a): the session's own uid, allocated once, no longer its NAS volume's. Unique among the
	-- member's sessions in the environment, so no two sessions on one of the member's machines share it.
	select guest_uid into v_guest_uid from public.qorpera_coding_session_uids where worker_id = v_worker.id;
	if v_guest_uid is null then
		perform pg_advisory_xact_lock(hashtextextended('qorpera.coding-guest-uid:' || v_worker.environment_id::text || ':' || v_worker.owner_user_id::text, 0));
		insert into public.qorpera_coding_session_uids(worker_id, environment_id, member_user_id, guest_uid)
		select v_worker.id, v_worker.environment_id, v_worker.owner_user_id, coalesce(max(session_uid.guest_uid), 199999) + 1
		from public.qorpera_coding_session_uids session_uid
		where session_uid.environment_id = v_worker.environment_id and session_uid.member_user_id = v_worker.owner_user_id
		returning guest_uid into v_guest_uid;
	end if;
$new$,
$old$'guestUid',v_volume.guest_uid$old$,
$new$'guestUid',v_guest_uid$new$]);

select pg_temp.s5a_patch('public.qorpera_assert_coding_storage(uuid,text,jsonb,text)'::regprocedure, array[
$old$		perform pg_advisory_xact_lock(hashtextextended('qorpera.coding-guest-uid:' || v_worker.environment_id::text || ':' || v_worker.owner_user_id::text, 0));
		insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding,
			member_user_id, guest_uid)
		values (v_worker.id, v_worker.environment_id, p_owner, p_machine_id_sha256, 1, v_expected, v_worker.owner_user_id,
			(select coalesce(max(volume.guest_uid), 199999) + 1 from public.qorpera_coding_storage_volumes volume
			 where volume.environment_id = v_worker.environment_id and volume.member_user_id = v_worker.owner_user_id));
$old$,
$new$		-- 20260930394000 (step 5a): the session's uid is no longer the volume's (qorpera_coding_session_uids).
		insert into public.qorpera_coding_storage_volumes(worker_id, environment_id, owner, machine_id_sha256, writer_generation, binding,
			member_user_id)
		values (v_worker.id, v_worker.environment_id, p_owner, p_machine_id_sha256, 1, v_expected, v_worker.owner_user_id);
$new$]);

-- 4. A machine stays while its own sessions are open. -------------------------------------------------------------------

-- Internal: a session on the machine that is not archived (20260930394000, step 5a: the machine's own sessions).
create or replace function public.qorpera_coding_member_has_open_session(p_machine public.qorpera_coding_machines)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_coding_sessions session
		where session.vm_allocation_id = p_machine.id and session.archived_at is null)
$$;
