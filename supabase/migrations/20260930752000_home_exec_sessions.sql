-- 20260930752000 (agent-box slice 1, 13 November 2026): a run's own session on its home machine.
--
-- P1 (lanes/agent-box-20261113/P1-CODEX-OWN-TOOLS.md) proved that the Codex we pin can run its OWN shell, stdin and
-- apply_patch on another machine through its exec-server, while the model's program and the member's sign-in stay in
-- the run's sealed slot. This migration is that channel's authority: which runs may open one, on which machine, and
-- the row every open and close is written to.
--
-- * The switch is OFF. A company has a home only when the platform's own switch is on AND that company is named
--   (qorpera_home_settings, qorpera_home_companies). With no rows at all, every company is as it is today: no
--   environment, no channel, the same tools and the same provider request.
-- * One session belongs to exactly one run, on one boot of one machine, and a run has one open per boot. A second
--   run cannot take it; the same run coming back with a new session id supersedes its own; and a session of a boot
--   that ended is refused: its home is gone with the boot, as a command's output is. The executor's guest shell
--   checks the boot again when it starts the exec-server.
-- * A home mounts its boot's company-wide view and its agent is root there, so a home may go only to runs that may
--   read the whole folder and share the machine: slice 3's rule (qorpera_folder_home_shared, 20260930754000), which
--   narrows the offer below and is asked again by the executor before every channel. Until that rule exists the
--   switch cannot be on for any company, whatever its rows say (qorpera_company_home_allowed).
-- * Nothing in this migration lets a command reach a sign-in, and nothing shows a member a command or a step.

-- ---------------------------------------------------------------------------
-- 1. The switch: the platform's, then the company's
-- ---------------------------------------------------------------------------
create table public.qorpera_home_settings (
	singleton boolean primary key default true check (singleton),
	enabled boolean not null default false,
	set_at timestamptz not null default clock_timestamp()
);
comment on table public.qorpera_home_settings is
	'The platform switch for agents'' home machines (an exec-server session for a run). No row, or enabled false: off everywhere.';

create table public.qorpera_home_companies (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	added_at timestamptz not null default clock_timestamp()
);
comment on table public.qorpera_home_companies is
	'The companies whose runs may open a session on their home machine, once the platform switch is on.';

alter table public.qorpera_home_settings enable row level security;
alter table public.qorpera_home_companies enable row level security;
revoke all on public.qorpera_home_settings, public.qorpera_home_companies from public, anon, authenticated, service_role;

-- Whether a company's runs may have a home now. Internal; both tables are operator-set. And only once slice 3's rule of
-- which runs may share a machine exists (20260930754000): without it a run whose agent or member may not read the
-- whole folder would get a root shell on a machine whose /company shows all of it.
create function public.qorpera_company_home_allowed(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select s.enabled from public.qorpera_home_settings s where s.singleton), false)
		and exists (select 1 from public.qorpera_home_companies c where c.profile_id = p_profile_id)
		and pg_catalog.to_regprocedure(
			'public.qorpera_folder_home_shared(public.qorpera_company_machines, uuid, uuid, uuid)') is not null;
$$;

-- ---------------------------------------------------------------------------
-- 2. What a run asks before it offers the model its own tools
-- ---------------------------------------------------------------------------
-- The home of the run's own agent, or none. A home needs three things: the switch on for this company, a company
-- conversation's run, and a machine of this agent's that is running now, because an environment the model is offered
-- but cannot reach would only refuse it. `machineId` is the machine the run's channel names in its handshake; the
-- answer is the whole truth of one run's home, asked once, as qorpera_company_machines_available is asked.
create function public.qorpera_company_home_available(p_binding jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity jsonb; v_machine public.qorpera_company_machines%rowtype;
begin
	if auth.role() is distinct from 'service_role' then
		raise exception 'Home availability is the runtime''s' using errcode = '42501'; end if;
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	if v_identity ->> 'audienceKind' is distinct from 'company'
		or not public.qorpera_company_home_allowed((v_identity ->> 'companyId')::uuid)
		or not public.qorpera_company_machines_available() then
		return jsonb_build_object('schema','qorpera.company-home/v1','available',false); end if;
	-- This agent's own running machine, the one it works on; the latest used of them when it has more than one.
	-- It must be running, not only on its way: a machine that is still starting would be offered to the model and
	-- then refuse its channel (MACHINE_NOT_RUNNING). `running_at` is the guest's own mark of its boot.
	select machine.* into v_machine from public.qorpera_company_machines machine
	where machine.profile_id = (v_identity ->> 'companyId')::uuid
		and machine.started_by_staff_agent_id = (v_identity ->> 'staffAgentId')::uuid
		and machine.removed_at is null and machine.desired_state = 'running'
		and (public.qorpera_company_machine_placement(machine.id)).running_at is not null
		and public.qorpera_company_machine_reserved(machine)
	order by machine.last_used_at desc nulls last, machine.created_at desc limit 1;
	return jsonb_build_object('schema','qorpera.company-home/v1','available',v_machine.id is not null,
		'machineId',v_machine.id,'machine',v_machine.name);
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The sessions
-- ---------------------------------------------------------------------------
create table public.qorpera_company_home_sessions (
	id uuid primary key,
	machine_id uuid not null references public.qorpera_company_machines(id) on delete restrict,
	placement_id uuid not null references public.qorpera_company_machine_placements(id) on delete restrict,
	boot_id uuid not null,
	run_id uuid not null references public.qorpera_execution_runs(id) on delete restrict,
	-- As a machine's and a command's agent is: the agent lives in the Company File, not in a table of its own.
	staff_agent_id uuid not null,
	requested_by_user_id uuid references auth.users(id) on delete set null,
	opened_at timestamptz not null default clock_timestamp(),
	closed_at timestamptz,
	close_reason text check (close_reason is null or close_reason in ('ended','stopped','lost','boot_ended','superseded')),
	check ((closed_at is null) = (close_reason is null))
);
comment on table public.qorpera_company_home_sessions is
	'One exec-server session of one run on one boot of its home machine: the channel P1 proved. Never shown to a member.';
create index qorpera_company_home_sessions_machine on public.qorpera_company_home_sessions(machine_id, opened_at desc);
create index qorpera_company_home_sessions_run on public.qorpera_company_home_sessions(run_id, opened_at desc);
create unique index qorpera_company_home_sessions_open
	on public.qorpera_company_home_sessions(placement_id, boot_id, run_id) where closed_at is null;

alter table public.qorpera_company_home_sessions enable row level security;
revoke all on public.qorpera_company_home_sessions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The executor's authority for one session
-- ---------------------------------------------------------------------------
-- Asked by the coding executor when a run's slot opens its channel, before any byte reaches the machine. It answers
-- the same shape a machine command's authority answers, so the executor routes it the same way (its own node, or a
-- peer's). A refusal is words the model can act on: the machine is not running, or this boot is over.
create function public.qorpera_authorize_home_session(p_binding jsonb, p_scope jsonb, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity jsonb; v_machine public.qorpera_company_machines%rowtype;
	v_placement public.qorpera_company_machine_placements%rowtype; v_session public.qorpera_company_home_sessions%rowtype;
	v_machine_id uuid;
begin
	if auth.role() is distinct from 'service_role' or jsonb_typeof(p_scope) is distinct from 'object'
		or p_scope - 'machineId' <> '{}'::jsonb or p_session_id is null then
		raise exception 'Home session scope invalid' using errcode = '22023'; end if;
	begin v_machine_id := (p_scope ->> 'machineId')::uuid;
	exception when invalid_text_representation then raise exception 'Home session scope invalid' using errcode = '22023'; end;
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	if v_identity ->> 'audienceKind' is distinct from 'company' then
		raise exception 'Machines belong to company conversations' using errcode = '42501'; end if;
	if not public.qorpera_company_home_allowed((v_identity ->> 'companyId')::uuid) then
		raise exception 'Home session authority unavailable' using errcode = '42501'; end if;
	-- The company's fence before its machine, as every path that touches a machine takes it (section 7 of 20260928259050).
	perform public.qorpera_company_machine_fence_briefly((v_identity ->> 'companyId')::uuid);
	select * into v_machine from public.qorpera_company_machines where id = v_machine_id;
	if v_machine.id is null or v_machine.profile_id::text is distinct from v_identity ->> 'companyId'
		or v_machine.removed_at is not null then
		raise exception 'Home session authority unavailable' using errcode = '42501'; end if;
	v_placement := public.qorpera_company_machine_placement(v_machine.id);
	if v_machine.desired_state <> 'running' or v_placement.running_at is null
		or not public.qorpera_company_machine_placement_reserved(v_placement.id) then
		return jsonb_build_object('schema','qorpera.home-session-authority/v1','state','refused','reason','MACHINE_NOT_RUNNING',
			'machine',v_machine.name,'machineState',public.qorpera_company_machine_state(v_machine)); end if;
	select * into v_session from public.qorpera_company_home_sessions where id = p_session_id;
	if v_session.id is not null and (v_session.run_id::text is distinct from p_binding ->> 'runId'
		or v_session.machine_id <> v_machine.id) then
		-- Another run's session, or another machine's: never adopted.
		raise exception 'Home session authority unavailable' using errcode = '42501'; end if;
	-- The boot as well as the disk: a machine that was restarted keeps its placement but starts a new boot, and a
	-- session of the boot before it must not reach the one after (review round 1, F4). Its home went with the boot,
	-- as a command's output does.
	if v_session.id is not null and (v_session.closed_at is not null
		or v_session.placement_id is distinct from v_placement.id or v_session.boot_id is distinct from v_placement.boot_id) then
		return jsonb_build_object('schema','qorpera.home-session-authority/v1','state','refused','reason','HOME_SESSION_ENDED',
			'machine',v_machine.name,'closeReason',v_session.close_reason); end if;
	if v_session.id is null then
		-- One channel per run on one boot. A run comes back here with a session id of its own only when its last host
		-- is gone (its slot was killed, its node restarted): nothing closed that row, and a refusal would shut the run
		-- out of its home for the rest of the boot. Its own earlier session is closed here as superseded, so the run
		-- always has exactly one open session and no row has to be cleaned up by hand (review round 1, F4 and F10).
		-- Another run's session is refused above and is never taken.
		update public.qorpera_company_home_sessions superseded
		set closed_at = clock_timestamp(), close_reason = 'superseded'
		where superseded.placement_id = v_placement.id and superseded.boot_id = v_placement.boot_id
			and superseded.run_id = (p_binding ->> 'runId')::uuid and superseded.closed_at is null;
		insert into public.qorpera_company_home_sessions(id, machine_id, placement_id, boot_id, run_id, staff_agent_id,
			requested_by_user_id)
		values (p_session_id, v_machine.id, v_placement.id, v_placement.boot_id, (p_binding ->> 'runId')::uuid,
			(v_identity ->> 'staffAgentId')::uuid, (v_identity ->> 'requesterUserId')::uuid)
		returning * into v_session;
	end if;
	update public.qorpera_company_machines set last_used_at = clock_timestamp() where id = v_machine.id;
	return jsonb_build_object('schema','qorpera.home-session-authority/v1','state','authorized','sessionId',v_session.id,
		'machineId',v_machine.id,'machine',v_machine.name,'placementId',v_placement.id,'bootId',v_placement.boot_id,
		'runId',v_session.run_id,'executorOwner',v_placement.owner,'providerId',v_placement.binding ->> 'providerId',
		'instanceSha256',v_placement.instance_sha256,'identity',v_identity);
end
$$;

-- The run's host closes its own session when the run ends or is stopped. A session nothing closed (its host was
-- killed) is superseded when the same run comes back, and a session of a boot that ended is refused HOME_SESSION_ENDED
-- whatever its row says, so no row has to be closed by hand.
create function public.qorpera_close_home_session(p_binding jsonb, p_session_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_identity jsonb; v_session public.qorpera_company_home_sessions%rowtype;
begin
	if auth.role() is distinct from 'service_role' or p_session_id is null
		or p_reason is null or p_reason not in ('ended','stopped','lost','boot_ended') then
		raise exception 'Home session scope invalid' using errcode = '22023'; end if;
	v_identity := public.qorpera_describe_native_tool_authority(p_binding) -> 'identity';
	select * into v_session from public.qorpera_company_home_sessions where id = p_session_id for update;
	if v_session.id is null or v_session.run_id::text is distinct from p_binding ->> 'runId' then
		raise exception 'Home session authority unavailable' using errcode = '42501'; end if;
	if v_session.closed_at is null then
		update public.qorpera_company_home_sessions set closed_at = clock_timestamp(), close_reason = p_reason
		where id = v_session.id returning * into v_session;
	end if;
	return jsonb_build_object('schema','qorpera.home-session-authority/v1','state','closed','sessionId',v_session.id,
		'closeReason',v_session.close_reason);
end
$$;

-- No member or agent reaches any of these: the switch is the operator's, and the channel is the runtime's and the
-- executor's (001_api_function_allowlist keeps the API's own list).
revoke all on function public.qorpera_company_home_allowed(uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_company_home_available(jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_authorize_home_session(jsonb, jsonb, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
revoke all on function public.qorpera_close_home_session(jsonb, uuid, text)
	from public, anon, authenticated, service_role, qorpera_secret_broker;
grant execute on function public.qorpera_company_home_available(jsonb) to service_role;
grant execute on function public.qorpera_authorize_home_session(jsonb, jsonb, uuid) to service_role;
grant execute on function public.qorpera_close_home_session(jsonb, uuid, text) to service_role;
