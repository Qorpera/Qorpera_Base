-- The payer of a routine never changes without permission (founder decision 2026-10-04; coordinator's rules of the same
-- day). 20260930059000 made a conversation and the work that follows a run keep their payer. A routine still chose its
-- own:
-- * a save took the saver's newest login or company account that could pay, the routine's own first only when it could
--   (qorpera_company_state_routine_payer, through qorpera_company_state_routine_saver_pays and the file rules), so a
--   routine whose login could not pay moved to the saver's other login or to a company account, and a member with two
--   logins could get the company account for a new routine;
-- * an agent's save prepared the requester's login, which was any binding that served them, else their newest one
--   (qorpera_agent_routine_sponsor, qorpera_ensure_unattended_sponsor).
-- Now:
-- * A routine keeps a payer that serves its saver: their own login, or a company account (one already chosen, or that
--   of a company-paid run that saves it), also when that payer cannot pay right now, at its limit, revoked or without
--   consent. The routine then waits as paused, needs_model_account, until someone picks a login for it.
-- * The pick is explicit and outside the file (qorpera_set_routine_login, new): a member picks one of their own logins
--   (and becomes the routine's saver), an owner or admin picks a company account (the saver stays).
-- * A save by someone the routine's payer does not serve (a new routine, or another member's) is that saver's own act:
--   their own login, or the saving run's login or company account, as their first choice. Never a company account for
--   a member's own save, unless one is picked.
-- * When a save or a pick changes who pays, the change is recorded (qorpera_routine_payer_changes, read with
--   qorpera_get_routine_payer: "paid by B since"), and the member whose login paid before is told
--   (member notification routine_payer_changed).
-- * An agent's save prepares only the login its run pays with (or the run's company account), never the member's other
--   login.
-- Locks: the new pick takes the folder fence and the company row KEY SHARE, the caller's member row KEY SHARE (rank 1),
-- then the routine row FOR NO KEY UPDATE (rank 5), as a routine's save does; the payer reads take no lock. Every new or
-- patched body carries the marker 20260930095000. Folder-v2 only.

create function pg_temp.routine_payer_replace(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930095000 anchor found % time(s) in %, expected 1',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Who a payer serves, and which binding pays ----------------------------------------------------------------------

-- A binding's current login serves a member when it is theirs, or a company account (which serves every member).
create function public.qorpera_company_state_routine_serves(p_profile_id uuid, p_binding_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	-- 20260930095000
	select coalesce((select connection.owner_user_id is null or connection.owner_user_id = p_user_id
		from public.qorpera_provider_connections as connection
		where connection.id = public.qorpera_sponsor_binding_connection(p_binding_id) and connection.profile_id = p_profile_id), false)
$$;
revoke all on function public.qorpera_company_state_routine_serves(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- The binding that pays a routine for a member: on the login of p_prefer_binding when that login serves them (only
-- there: a routine never moves to another login on its own), else their own login, newest first (a first choice; never a
-- company account).
create or replace function public.qorpera_company_state_routine_payer(p_profile_id uuid, p_user_id uuid, p_prefer_binding uuid)
returns table(binding_id uuid, version bigint)
language sql stable security definer set search_path = '' as $$
	-- 20260930095000: a payer that serves the member is kept; otherwise only their own login is a first choice.
	with followed as (
		select public.qorpera_sponsor_binding_connection(p_prefer_binding) as connection_id
		where public.qorpera_company_state_routine_serves(p_profile_id, p_prefer_binding, p_user_id)
	)
	select binding.id, sponsor.version
	from public.qorpera_execution_sponsor_bindings binding
	join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = binding.id
	join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions connection_version on connection_version.connection_id = connection.id
		and connection_version.version = sponsor.provider_connection_version
	where binding.profile_id = p_profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and connection.profile_id = p_profile_id and connection.status = 'active'
		and public.qorpera_provider_execution_enabled(connection.provider, connection_version.authentication_mode,
			connection_version.native_harness)
		and connection_version.authorization_state = 'active' and connection_version.allow_autonomous
		and not exists (select 1 from public.qorpera_provider_connection_versions later
			where later.connection_id = connection.id and later.version > connection_version.version and not later.allow_autonomous)
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions latest
			where latest.binding_id = binding.id)
		and public.qorpera_sponsor_serves_requester(p_profile_id, binding.id, sponsor.version, p_user_id)
		-- Claude logins are for coding only; they never pay for agent routines.
		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
		and case when exists (select 1 from followed) then connection.id = (select followed.connection_id from followed)
			else connection.owner_user_id = p_user_id end
	order by (binding.id = p_prefer_binding) desc, sponsor.created_at desc, binding.id
	limit 1
$$;

-- Who pays for a save: the routine keeps a payer that serves the saver; else the saving run's payer; else the saver's
-- own first choice. A routine no login pays for keeps the login it follows and waits for it (for a pick).
create or replace function public.qorpera_company_state_routine_saver_pays(p_commit public.qorpera_folder_commits,
	p_profile_id uuid, p_current public.qorpera_cloud_routine_versions, out binding_id uuid, out version bigint,
	out user_id uuid, out paid boolean)
returns record language plpgsql stable security definer set search_path = '' as $$
declare v_prefer uuid; v_prefer_version bigint;
begin
	if p_commit.actor_kind = 'platform' then
		binding_id := p_current.sponsor_binding_id; version := p_current.sponsor_version; user_id := p_current.created_by_user_id;
		paid := public.qorpera_company_state_routine_paid(p_current);
		return;
	end if;
	user_id := p_commit.requester_id;
	-- 20260930095000: the payer this save follows.
	if p_current.routine_id is not null
		and public.qorpera_company_state_routine_serves(p_profile_id, p_current.sponsor_binding_id, p_commit.requester_id) then
		v_prefer := p_current.sponsor_binding_id; v_prefer_version := p_current.sponsor_version;
	elsif p_commit.run_id is not null
		and public.qorpera_company_state_routine_serves(p_profile_id, p_commit.sponsor_binding_id, p_commit.requester_id) then
		v_prefer := p_commit.sponsor_binding_id; v_prefer_version := p_commit.sponsor_version;
	end if;
	select p.binding_id, p.version into binding_id, version
	from public.qorpera_company_state_routine_payer(p_profile_id, p_commit.requester_id, v_prefer) p;
	paid := binding_id is not null;
	if paid then return; end if;
	if v_prefer is not null then
		binding_id := v_prefer; version := v_prefer_version;
	elsif p_commit.run_id is not null then
		binding_id := p_commit.sponsor_binding_id; version := p_commit.sponsor_version;
	else
		select s.binding_id, s.version into binding_id, version
		from public.qorpera_execution_sponsor_versions s
		join public.qorpera_execution_sponsor_bindings b on b.id = s.binding_id
		join public.qorpera_provider_connections c on c.id = s.provider_connection_id
		where b.profile_id = p_profile_id and c.owner_user_id = p_commit.requester_id
		order by s.created_at desc, s.binding_id limit 1;
	end if;
end $$;

-- 2. A changed payer is recorded, and the member whose login paid before is told -------------------------------------

create table public.qorpera_routine_payer_changes (
	routine_id uuid not null references public.qorpera_cloud_routines(id) on delete cascade,
	routine_version bigint not null,
	from_connection_id uuid not null,
	to_connection_id uuid not null,
	-- The member whose login pays now; null for a company account.
	payer_user_id uuid,
	changed_by_user_id uuid,
	reason text not null check (reason in ('save', 'pick')),
	changed_at timestamptz not null default statement_timestamp(),
	primary key (routine_id, routine_version)
);
alter table public.qorpera_routine_payer_changes enable row level security;
revoke all on public.qorpera_routine_payer_changes from public, anon, authenticated, service_role;

alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind;
alter table public.qorpera_member_notifications add constraint qorpera_member_notifications_kind
	check (kind in ('provider_usage_limit','sponsor_handoff','routine_needs_model_account','routine_suspended',
		'run_no_progress','routine_payer_changed'));

-- Records a routine version whose payer is another login than the version before it; tells that login's member, unless
-- they made the change. Writes only the routine's own change row and one notification (the company row is held KEY
-- SHARE by every caller already).
create function public.qorpera_record_routine_payer_change(p_routine_id uuid, p_version bigint, p_from_binding uuid,
	p_from_version bigint, p_to_binding uuid, p_to_version bigint, p_by uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_from public.qorpera_provider_connections%rowtype; v_to public.qorpera_provider_connections%rowtype;
	v_routine public.qorpera_cloud_routines%rowtype;
begin
	-- 20260930095000
	select connection.* into v_from from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	where sponsor.binding_id = p_from_binding and sponsor.version = p_from_version;
	select connection.* into v_to from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	where sponsor.binding_id = p_to_binding and sponsor.version = p_to_version;
	if v_from.id is null or v_to.id is null or v_from.id = v_to.id then return; end if;
	select * into strict v_routine from public.qorpera_cloud_routines where id = p_routine_id;
	insert into public.qorpera_routine_payer_changes(routine_id, routine_version, from_connection_id, to_connection_id,
		payer_user_id, changed_by_user_id, reason)
	values (p_routine_id, p_version, v_from.id, v_to.id, v_to.owner_user_id, p_by, p_reason)
	on conflict (routine_id, routine_version) do nothing;
	if v_from.owner_user_id is not null and v_from.owner_user_id is distinct from p_by then
		insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
		values (v_routine.profile_id, v_from.owner_user_id, 'routine_payer_changed', jsonb_build_object(
			'schema', 'qorpera.member-notification.routine-payer-changed/v1', 'routineId', p_routine_id,
			'routineVersion', p_version, 'staffAgentId', v_routine.owner_staff_agent_id,
			'payer', case when v_to.owner_user_id is null then 'company' else 'member' end,
			'payerUserId', v_to.owner_user_id, 'changedByUserId', p_by, 'reason', p_reason, 'at', statement_timestamp()),
			p_routine_id::text || ':' || p_version::text)
		on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
	end if;
end $$;
revoke all on function public.qorpera_record_routine_payer_change(uuid, bigint, uuid, bigint, uuid, bigint, uuid, text)
	from public, anon, authenticated, service_role;

-- 3. The file rules, a save and a handover keep a payer that serves the saver ---------------------------------------
select pg_temp.routine_payer_replace('public.qorpera_company_state_routine_rules(uuid,uuid,jsonb,text,jsonb,boolean)'::regprocedure,
$old$			and not exists (select 1 from public.qorpera_company_state_routine_payer(p_profile_id,
				coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid, v_version.sponsor_binding_id)) then
$old$,
$new$			and not exists (select 1 from public.qorpera_company_state_routine_payer(p_profile_id,
				coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid, v_version.sponsor_binding_id))
			-- 20260930095000: a routine whose payer serves the saver keeps it and waits for it; only a first choice needs a login.
			and not public.qorpera_company_state_routine_serves(p_profile_id, v_version.sponsor_binding_id,
				coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid) then
$new$);
select pg_temp.routine_payer_replace('public.qorpera_company_state_index_routine(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure,
$old$		returning created_at into v_created;
$old$,
$new$		returning created_at into v_created;
		-- 20260930095000: a save that changes who pays is recorded, and the member whose login paid before is told.
		if v_current.routine_id is not null then
			perform public.qorpera_record_routine_payer_change(v_id, v_next, v_current.sponsor_binding_id, v_current.sponsor_version,
				v_pay.binding_id, v_pay.version, v_pay.user_id, 'save');
		end if;
$new$);
select pg_temp.routine_payer_replace('public.qorpera_folder_structured_decide(uuid,jsonb,uuid,integer,jsonb,text,text)'::regprocedure,
$old$					and not exists (select 1 from public.qorpera_company_state_routine_payer(v_profile,
						coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid, null)) then
$old$,
$new$					and not exists (select 1 from public.qorpera_company_state_routine_payer(v_profile,
						coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid, null))
					-- 20260930095000: a routine whose payer serves the mover keeps it (and waits for it when it cannot pay).
					and not exists (select 1 from public.qorpera_cloud_routine_versions cv where cv.routine_id = v_carried.id
						and cv.version = v_carried.current_version and public.qorpera_company_state_routine_serves(v_profile,
							cv.sponsor_binding_id, coalesce(p_actor ->> 'userId', p_actor ->> 'requesterUserId')::uuid)) then
$new$);

-- 4. An agent's save prepares only its run's login ------------------------------------------------------------------
select pg_temp.routine_payer_replace('public.qorpera_ensure_unattended_sponsor(public.qorpera_execution_runs)'::regprocedure,
$old$	and not public.qorpera_connection_plan_awaits_consent(connection.id)
	order by (connection.id = (select sponsor.provider_connection_id from public.qorpera_execution_sponsor_versions sponsor
			where sponsor.binding_id = p_run.sponsor_binding_id and sponsor.version = p_run.sponsor_version)) desc,
		connection.created_at desc
	limit 1 for update;
$old$,
$new$	and not public.qorpera_connection_plan_awaits_consent(connection.id)
		-- 20260930095000: only the login the run pays with now, never the member's other login.
		and connection.id = public.qorpera_sponsor_binding_connection(p_run.sponsor_binding_id)
	limit 1 for update;
$new$);

-- The login an agent's routine is prepared on: the one its run pays with now (or the run's company account), never
-- another binding that serves the requester.
create or replace function public.qorpera_agent_routine_sponsor(p_run public.qorpera_execution_runs)
returns table(binding_id uuid, version bigint, owner_user_id uuid)
language sql stable security definer set search_path = '' as $$
	select binding.id, sponsor.version, connection.owner_user_id
	from public.qorpera_execution_sponsor_bindings binding
	join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = binding.id
	join public.qorpera_provider_connections connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions connection_version on connection_version.connection_id = connection.id
		and connection_version.version = sponsor.provider_connection_version
	where binding.profile_id = p_run.profile_id and binding.status = 'active' and sponsor.allow_autonomous
		and connection.profile_id = p_run.profile_id and connection.status = 'active'
		and public.qorpera_provider_execution_enabled(connection.provider, connection_version.authentication_mode,
			connection_version.native_harness)
		and public.qorpera_provider_autonomous_authority(connection.id, sponsor.provider_connection_version)
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions latest
			where latest.binding_id = binding.id)
		and public.qorpera_sponsor_serves_requester(p_run.profile_id, binding.id, sponsor.version, p_run.requested_by_user_id)
		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
		-- 20260930095000: only the login the run pays with now.
		and connection.id = public.qorpera_sponsor_binding_connection(p_run.sponsor_binding_id)
	order by (binding.id = p_run.sponsor_binding_id) desc, sponsor.created_at desc, binding.id
	limit 1
$$;

-- 5. The explicit pick ---------------------------------------------------------------------------------------------

-- A member picks the login a routine runs on: one of their own logins (they become its saver), or, as an owner or
-- admin, a company account (its saver stays). Only a login that can pay for the routine's work while its member is away
-- now. The routine gets a version on that login; one waiting for a login (needs_model_account) runs again.
create function public.qorpera_set_routine_login(p_routine_id uuid, p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_routine public.qorpera_cloud_routines%rowtype;
	v_current public.qorpera_cloud_routine_versions%rowtype; v_connection public.qorpera_provider_connections%rowtype;
	v_role text; v_requester uuid; v_binding uuid; v_pay record; v_status text; v_reason text; v_next bigint;
	v_created timestamptz; v_trigger jsonb;
begin
	-- 20260930095000
	if auth.role() is distinct from 'authenticated' or v_user is null or p_routine_id is null or p_connection_id is null then
		raise exception 'Routine is unavailable' using errcode = '42501'; end if;
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id;
	if not found or v_routine.folder_environment_id is null or not public.qorpera_company_is_folder_v2(v_routine.profile_id) then
		raise exception 'Routine is unavailable' using errcode = '42501'; end if;
	-- The core's order: the fence and the company row KEY SHARE, the member (rank 1), then the routine (rank 5).
	perform public.qorpera_folder_machine_fence(v_routine.profile_id);
	select member.role into v_role from public.qorpera_profile_members as member
	where member.profile_id = v_routine.profile_id and member.user_id = v_user for key share;
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id for no key update;
	if v_role is null or v_role not in ('owner', 'admin', 'contributor') or v_routine.folder_retired_at is not null
		or v_routine.status = 'retired'
		or not public.qorpera_folder_actor_allowed(v_routine.folder_environment_id, v_routine.profile_id,
			public.qorpera_member_folder_actor(v_routine.folder_environment_id), v_routine.folder_path, 'write') then
		raise exception 'Routine is unavailable' using errcode = '42501'; end if;
	select * into strict v_current from public.qorpera_cloud_routine_versions
	where routine_id = v_routine.id and version = v_routine.current_version;
	select * into v_connection from public.qorpera_provider_connections
	where id = p_connection_id and profile_id = v_routine.profile_id;
	if v_connection.id is null or (v_connection.owner_user_id is not null and v_connection.owner_user_id <> v_user)
		or (v_connection.owner_user_id is null and v_role not in ('owner', 'admin')) then
		raise exception 'This login cannot pay for this routine' using errcode = '42501'; end if;
	-- A member's own login makes them the routine's saver; a company account serves the saver it has.
	v_requester := coalesce(v_connection.owner_user_id, v_current.created_by_user_id);
	select binding.id into v_binding from public.qorpera_execution_sponsor_bindings as binding
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
	where binding.profile_id = v_routine.profile_id and sponsor.provider_connection_id = p_connection_id
	order by sponsor.created_at desc, binding.id limit 1;
	select * into v_pay from public.qorpera_company_state_routine_payer(v_routine.profile_id, v_requester, v_binding);
	if v_pay.binding_id is null or public.qorpera_sponsor_binding_connection(v_pay.binding_id) is distinct from p_connection_id then
		raise exception 'This login cannot pay for this routine' using errcode = '22023'; end if;
	if exists (select 1 from jsonb_array_elements(v_current.triggers) as trigger(value) where trigger.value ->> 'kind' = 'listener')
		and public.qorpera_sponsor_version_is_chatgpt_plan(v_pay.binding_id, v_pay.version) then
		raise exception 'A ChatGPT plan cannot pay for a listener' using errcode = '42501'; end if;

	v_status := v_routine.status; v_reason := v_routine.pause_reason;
	-- A routine that waited for a login runs again, as a paid save leaves it.
	if v_status = 'paused' and v_reason = 'needs_model_account' then
		v_status := 'active'; v_reason := null;
		if v_routine.max_occurrences is not null and public.qorpera_routine_occurrence_count(v_routine.id) >= v_routine.max_occurrences
			or v_routine.expires_at is not null and v_routine.expires_at <= statement_timestamp() then
			v_status := 'expired';
		elsif not exists (select 1 from public.qorpera_profile_staff as staff where staff.profile_id = v_routine.profile_id
			and staff.staff_agent_id = v_routine.owner_staff_agent_id and staff.employment_status = 'active'
			and staff.folder_retired_at is null) then
			v_status := 'paused'; v_reason := 'agent_archived';
		end if;
	end if;
	v_next := v_routine.current_version;
	if v_pay.binding_id is distinct from v_current.sponsor_binding_id or v_pay.version is distinct from v_current.sponsor_version
		or v_requester is distinct from v_current.created_by_user_id then
		v_next := v_routine.current_version + 1;
		insert into public.qorpera_cloud_routine_versions
		select (jsonb_populate_record(null::public.qorpera_cloud_routine_versions, to_jsonb(v_current)
			|| jsonb_build_object('version', v_next, 'client_version_id', extensions.gen_random_uuid(),
				'sponsor_binding_id', v_pay.binding_id, 'sponsor_version', v_pay.version, 'created_by_user_id', v_requester,
				'content_sha256', public.qorpera_company_state_routine_sha(v_current.staff_agent_id, v_current.title,
					v_current.prompt, v_current.triggers, v_current.effort, v_pay.binding_id, v_pay.version),
				'created_at', clock_timestamp()))).*
		returning created_at into v_created;
		-- Each schedule trigger keeps its position, as a save with the same timing does.
		for v_trigger in select trigger.value from jsonb_array_elements(v_current.triggers) as trigger(value)
			where trigger.value ->> 'kind' = 'schedule' loop
			insert into public.qorpera_cloud_routine_schedule_cursors(routine_id, routine_version, trigger_id, last_scheduled_for,
				next_due_at)
			select v_routine.id, v_next, v_trigger ->> 'id', position.last_scheduled_for, position.next_due_at
			from public.qorpera_routine_version_schedule_position(v_routine.id, v_routine.current_version, v_trigger, v_created,
				v_routine.status = 'active', v_status = 'active') as position;
		end loop;
		perform public.qorpera_record_routine_payer_change(v_routine.id, v_next, v_current.sponsor_binding_id,
			v_current.sponsor_version, v_pay.binding_id, v_pay.version, v_user, 'pick');
	end if;
	update public.qorpera_cloud_routines set current_version = v_next, status = v_status, pause_reason = v_reason,
		authorization_failures = case when v_status = 'active' then 0 else authorization_failures end,
		updated_at = statement_timestamp()
	where id = v_routine.id;
	return public.qorpera_get_routine_payer(v_routine.id);
end $$;

-- What the routine editor shows: the login a routine runs on, whether it can pay now, and since when and by whose save
-- or pick it is the one. For a member who may read the routine's file.
create function public.qorpera_get_routine_payer(p_routine_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_current public.qorpera_cloud_routine_versions%rowtype;
	v_connection public.qorpera_provider_connections%rowtype; v_change public.qorpera_routine_payer_changes%rowtype;
begin
	-- 20260930095000
	select * into v_routine from public.qorpera_cloud_routines where id = p_routine_id;
	if not found or v_routine.folder_environment_id is null or v_routine.folder_retired_at is not null
		or not public.qorpera_folder_actor_allowed(v_routine.folder_environment_id, v_routine.profile_id,
			public.qorpera_member_folder_actor(v_routine.folder_environment_id), v_routine.folder_path, 'read') then
		raise exception 'Routine is unavailable' using errcode = '42501'; end if;
	select * into strict v_current from public.qorpera_cloud_routine_versions
	where routine_id = v_routine.id and version = v_routine.current_version;
	select connection.* into v_connection from public.qorpera_provider_connections as connection
	where connection.id = public.qorpera_sponsor_binding_connection(v_current.sponsor_binding_id);
	select * into v_change from public.qorpera_routine_payer_changes
	where routine_id = v_routine.id order by routine_version desc limit 1;
	return jsonb_build_object('schema', 'qorpera.routine-payer/v1', 'routineId', v_routine.id,
		'routineVersion', v_routine.current_version, 'status', v_routine.status, 'pauseReason', v_routine.pause_reason,
		'connectionId', v_connection.id,
		'payer', case when v_connection.id is null then null when v_connection.owner_user_id is null then 'company' else 'member' end,
		'payerUserId', v_connection.owner_user_id, 'savedByUserId', v_current.created_by_user_id,
		'canPay', public.qorpera_company_state_routine_paid(v_current),
		'since', coalesce(v_change.changed_at, v_routine.created_at), 'changedByUserId', v_change.changed_by_user_id,
		'changeReason', v_change.reason);
end $$;

revoke all on function public.qorpera_set_routine_login(uuid, uuid), public.qorpera_get_routine_payer(uuid)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_set_routine_login(uuid, uuid), public.qorpera_get_routine_payer(uuid) to authenticated;
