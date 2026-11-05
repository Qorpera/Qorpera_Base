-- Work moves to the member's own login with room when theirs reaches its usage limit (founder, 5 Nov 2026).
--
-- "it won't automatically switch the subscription token, but wait until I press this button to do so in the chat. it
-- should do so automatically. or if there are no accounts with usage remaining, it should refresh it once daily to see if
-- usage is back so it can continue". The founder had two ChatGPT logins of his own: one at its usage limit, one with 97%
-- left. Work waited on the first until he picked the second by hand in the chat.
--
-- This reverses the 4 October rule (20260930059000, 20260930095000) for a member's OWN logins only:
-- * When a login of member M reached its usage limit, or cannot pay now (it needs a new sign-in, its credential or its
--   computer is not usable, an owner or admin turned it off, its consent is off, or M disconnected it), M's work moves to
--   another of M's own logins of the same kind that has room, the one with the most room on one scale
--   (qorpera_native_account_rank, 20260930559000). A login with room is kept, so a conversation's prompt cache stays.
--   - A conversation: qorpera_select_member_session_account (the web asks it on every read, every 30 s at most).
--   - Work that follows a run (coworker, worker and other agent wakes, a change's review): qorpera_starter_sponsor.
--   - A routine paid by M's login: each run (its wake) pays with M's login with room while the routine's own one cannot
--     (qorpera_routine_wake_payer, from the pin trigger). The routine keeps its own login; the admission and the policy
--     accept a run on another login of the same member (qorpera_routine_runs_on_own_login). The routine editor reads it
--     as able to pay then.
--   - A coding session paid by M: a turn that begins moves the session to M's login with room first, as the owner's own
--     pick does (qorpera_coding_session_move_at_limit, from qorpera_begin_coding_turn).
-- * Never: another member's login, a company account, or a ChatGPT plan login chosen on its own. A company account at its
--   limit keeps its work as before. Logins are never pooled or proxied: each run pays with one login.
-- * When none of M's logins has room, the work waits and does not fail:
--   - The wall a usage limit puts on a login ends at the provider's reset when it is known, else 6 hours after the limit,
--     and now never later than one day after it (qorpera_native_account_usage_limit_reset_company). A paused run comes
--     back then too (qorpera_resume_run_from_log). So waiting work is tried again at the reset, and at least once a day.
--   - Codex's usage-limit error names no reset time (codexErrorInfo is the bare name usageLimitExceeded), so no signal
--     had one. The signal now takes the reset from the login's newest usage reading (the one Settings → Refresh records):
--     the latest reset still ahead of a window at 100% (qorpera_native_account_reading_reset).
-- * The member is told: the usage-limit notice now names the login and, when there is one, the login work moved to
--   (accountEmail, movedTo; the web writes one plain sentence). Its kind and schema are unchanged.
-- * The member's own pick (the chat's login menu, a routine's or a coding session's login) still works as an override.
--
-- Locks: no new ones. The conversation keeps its one row lock; the coding move runs inside qorpera_begin_coding_turn after
-- its worker and session locks and takes a binding row as the owner's pick does; the payer functions only read.
-- Every new or changed body carries the marker 20260930575000.

set local lock_timeout = '3s';

do $$
begin
	if position('20260930575000' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) > 0 then
		raise exception '20260930575000 is already applied'; end if;
	if position('20260930559000' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) = 0
		or position('20260930559000' in pg_get_functiondef('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure)) = 0
		or to_regprocedure('public.qorpera_coding_session_login_candidates(public.qorpera_runtime_workers,text)') is null
		or to_regprocedure('public.qorpera_native_account_rank(uuid,bigint)') is null then
		raise exception '20260930575000 needs 20260930551000 and 20260930559000'; end if;
end $$;

create function pg_temp.as575_patch(p_target regprocedure, p_old text, p_new text, p_count integer default 1)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> p_count then
		raise exception '20260930575000 anchor found % time(s) in %, expected %: %',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target, p_count, left(p_old, 80);
	end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- 1. Which of a member's own logins has room -------------------------------------------------------------------------

-- The member's own logins that may pay for an agent's work while they are away (qorpera_starter_sponsor's own logins),
-- usable now: an active credential and no new sign-in needed. With their room (qorpera_native_account_remaining: 0 at
-- the usage limit, -1 unknown) and whether each is a ChatGPT plan.
create function public.qorpera_member_work_logins(p_profile_id uuid, p_user_id uuid, p_staff_agent_id uuid)
returns table(binding_id uuid, version bigint, connection_id uuid, connection_version bigint, created_at timestamptz,
	remaining numeric, plan boolean)
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select binding.id, sponsor.version, connection.id, version.version, sponsor.created_at,
		public.qorpera_native_account_remaining(connection.id, version.version),
		public.qorpera_connection_is_chatgpt_plan(connection.id)
	from public.qorpera_execution_sponsor_bindings as binding
	join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
		and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
			where latest.binding_id = binding.id)
	join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
	join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
		and version.version = sponsor.provider_connection_version
	join public.qorpera_profile_staff as staff on staff.profile_id = p_profile_id
		and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active'
	where binding.profile_id = p_profile_id and binding.status = 'active'
		and sponsor.sponsor_kind = 'member_connection' and sponsor.allow_autonomous
		and connection.profile_id = p_profile_id and connection.status = 'active'
		and connection.owner_user_id = p_user_id
		and connection.provider = coalesce(staff.model_provider, 'openai')
		and version.authorization_state = 'active' and version.allow_autonomous
		and version.native_harness <> 'claude-code'
		and not exists (select 1 from public.qorpera_provider_connection_versions as newer
			where newer.connection_id = connection.id and newer.version > version.version)
		and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
		and (version.authentication_mode <> 'native_subscription' or exists (select 1
			from public.qorpera_native_credential_capsules as capsule
			where capsule.id = version.credential_capsule_id and capsule.status = 'active'))
		and not exists (select 1 from public.qorpera_model_logins as login
			where login.credential_capsule_id = version.credential_capsule_id and login.status <> 'active')
		and exists (select 1 from public.qorpera_profile_members as member
			where member.profile_id = p_profile_id and member.user_id = p_user_id)
$$;

-- The member's own login with the most room for an agent's work, other than p_except_connection_id: never a ChatGPT plan
-- (one pays only for work started on it), never one at its usage limit.
create function public.qorpera_member_work_login_with_room(p_profile_id uuid, p_user_id uuid, p_staff_agent_id uuid,
	p_except_connection_id uuid)
returns table(binding_id uuid, version bigint, connection_id uuid)
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select work.binding_id, work.version, work.connection_id
	from public.qorpera_member_work_logins(p_profile_id, p_user_id, p_staff_agent_id) as work
	where work.connection_id is distinct from p_except_connection_id and work.remaining <> 0 and not work.plan
	order by public.qorpera_native_account_rank(work.connection_id, work.connection_version), work.created_at desc,
		work.binding_id
	limit 1
$$;

-- Whether that login can pay for the member's agent work now and has room.
create function public.qorpera_member_work_login_has_room(p_profile_id uuid, p_user_id uuid, p_staff_agent_id uuid,
	p_connection_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select exists (select 1 from public.qorpera_member_work_logins(p_profile_id, p_user_id, p_staff_agent_id) as work
		where work.connection_id = p_connection_id and work.remaining <> 0)
$$;

-- The member's own conversation login with the most room (qorpera_member_live_accounts) to take over from
-- p_except_connection_id: never a ChatGPT plan, and nothing for work on a plan (a plan is a login of another kind).
create function public.qorpera_member_session_login_with_room(p_profile_id uuid, p_user_id uuid, p_except_connection_id uuid)
returns table(connection_id uuid, binding_id uuid)
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select candidate.connection_id, candidate.binding_id
	from public.qorpera_member_live_accounts(p_profile_id, p_user_id) as candidate
	where candidate.connection_id is distinct from p_except_connection_id and candidate.remaining <> 0
		and public.qorpera_company_state_routine_waits(candidate.connection_id) is distinct from 'sign_in'
		and not public.qorpera_connection_is_chatgpt_plan(candidate.connection_id)
		and (p_except_connection_id is null or not public.qorpera_connection_is_chatgpt_plan(p_except_connection_id))
	order by public.qorpera_native_account_rank(candidate.connection_id, (select max(version.version)
			from public.qorpera_provider_connection_versions as version where version.connection_id = candidate.connection_id)),
		candidate.connection_id, candidate.binding_id
	limit 1
$$;

revoke all on function public.qorpera_member_work_logins(uuid, uuid, uuid),
	public.qorpera_member_work_login_with_room(uuid, uuid, uuid, uuid),
	public.qorpera_member_work_login_has_room(uuid, uuid, uuid, uuid),
	public.qorpera_member_session_login_with_room(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- 2. A conversation ----------------------------------------------------------------------------------------------------

create or replace function public.qorpera_select_member_session_account(p_profile_id uuid, p_session_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_saved public.qorpera_member_session_accounts%rowtype; v_choice record;
    v_other record; v_current uuid; v_kept boolean;
begin
    if auth.role() is distinct from 'authenticated' or v_user is null
        or not public.qorpera_can_read_session(p_session_id) then
        raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    -- Serialize initial selection and replacement across this conversation's tabs.
    perform 1 from public.qorpera_shared_sessions where id = p_session_id and profile_id = p_profile_id for update;
    if not found then raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    select * into v_saved from public.qorpera_member_session_accounts
        where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
    if found then
        -- The conversation's login, also after the member signed in again (its binding follows them to the new
        -- connection for the same account, qorpera_move_member_login_pins; 20260930059000).
        v_current := coalesce(public.qorpera_sponsor_binding_connection(v_saved.sponsor_binding_id), v_saved.connection_id);
        select * into v_choice from public.qorpera_member_live_accounts(p_profile_id,v_user) candidate
            where candidate.connection_id = v_current
            order by (candidate.binding_id = v_saved.sponsor_binding_id) desc,candidate.binding_id limit 1;
        v_kept := found;
        -- 20260930575000: a login with room is kept, so the conversation's prompt cache stays warm.
        if v_kept and v_choice.remaining <> 0
            and public.qorpera_company_state_routine_waits(v_current) is distinct from 'sign_in' then
            update public.qorpera_member_session_accounts set connection_id = v_choice.connection_id,
                sponsor_binding_id = v_choice.binding_id,
                selected_at = case when connection_id = v_choice.connection_id then selected_at else clock_timestamp() end
            where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
            return v_choice.connection_id;
        end if;
        -- 20260930575000: at its usage limit, or unable to pay now (a new sign-in, its computer recovering, consent or
        -- the provider switched off, an owner or admin's disable, disconnected), the conversation moves to the member's
        -- own login with the most room. Never another member's login or a company account.
        select * into v_other from public.qorpera_member_session_login_with_room(p_profile_id, v_user, v_current);
        if found then
            update public.qorpera_member_session_accounts set connection_id = v_other.connection_id,
                sponsor_binding_id = v_other.binding_id, selected_at = clock_timestamp()
            where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
            return v_other.connection_id;
        end if;
        -- No login of the member has room: the conversation keeps its own, and sending waits until one has room again
        -- (the wall of a usage limit ends at its reset, at the latest a day after it).
        if v_kept then
            update public.qorpera_member_session_accounts set connection_id = v_choice.connection_id,
                sponsor_binding_id = v_choice.binding_id,
                selected_at = case when connection_id = v_choice.connection_id then selected_at else clock_timestamp() end
            where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
            return v_choice.connection_id;
        end if;
        if exists (select 1 from public.qorpera_provider_connections connection where connection.id = v_current
            and connection.profile_id = p_profile_id and connection.owner_user_id = v_user and connection.status <> 'revoked') then
            return v_current;
        end if;
        return null;
    end if;
    -- A new conversation's first choice: the member's login with the most room left; unknown usage sorts last.
    select * into v_choice from public.qorpera_eligible_member_accounts(p_profile_id,v_user) candidate
        -- 20260930559000: a login that works and the most room on one scale (qorpera_native_account_rank).
        order by public.qorpera_native_account_rank(candidate.connection_id, (select max(version.version)
                from public.qorpera_provider_connection_versions as version
                where version.connection_id = candidate.connection_id)),
            candidate.connection_id,candidate.binding_id limit 1;
    if not found then return null; end if;
    insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
        values(p_profile_id,p_session_id,v_user,v_choice.connection_id,v_choice.binding_id)
        on conflict(profile_id,session_id,user_id) do update set
            connection_id = excluded.connection_id,sponsor_binding_id = excluded.sponsor_binding_id,
            selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
                then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
    return v_choice.connection_id;
end $$;

-- 3. Work that follows a run --------------------------------------------------------------------------------------------

create or replace function public.qorpera_starter_sponsor(p_profile_id uuid, p_requester uuid, p_staff_agent_id uuid,
	p_prefer_binding_id uuid)
returns table (binding_id uuid, version bigint)
language sql
stable
security definer
set search_path = ''
as $$
	with own as (
		select binding.id as binding_id, sponsor.version, connection.id as connection_id,
			public.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at,
			version.version as connection_version
		from public.qorpera_execution_sponsor_bindings as binding
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.binding_id = binding.id
			and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
				where latest.binding_id = binding.id)
		join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
		join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
			and version.version = sponsor.provider_connection_version
		join public.qorpera_profile_staff as staff on staff.profile_id = p_profile_id
			and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active'
		where binding.profile_id = p_profile_id and binding.status = 'active'
			and sponsor.sponsor_kind = 'member_connection' and sponsor.allow_autonomous
			and connection.profile_id = p_profile_id and connection.status = 'active'
			and connection.owner_user_id = p_requester
			and connection.provider = coalesce(staff.model_provider, 'openai')
			and version.authorization_state = 'active' and version.allow_autonomous
			and version.native_harness <> 'claude-code'
			and not exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = connection.id and newer.version > version.version)
			and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
			and exists (select 1 from public.qorpera_profile_members as member
				where member.profile_id = p_profile_id and member.user_id = p_requester)
	),
	-- The login that pays for the run this work follows (its binding's current version). It is the requester's own or a
	-- company account; a login of another member pays for none of the requester's work, so that work starts anew.
	followed as (
		select connection.id as connection_id, connection.owner_user_id is null as company
		from public.qorpera_provider_connections as connection
		where connection.id = public.qorpera_sponsor_binding_connection(p_prefer_binding_id)
			and (connection.owner_user_id is null or connection.owner_user_id = p_requester)
	),
	-- 20260930575000: the requester's own login the work moves to while the followed one (also their own) is at its usage
	-- limit or cannot pay now: their own login with the most room. Never a company account or a ChatGPT plan.
	moved as (
		select room.binding_id, room.version
		from followed
		cross join lateral public.qorpera_member_work_login_with_room(p_profile_id, p_requester, p_staff_agent_id,
			followed.connection_id) as room
		where not followed.company and not public.qorpera_connection_is_chatgpt_plan(followed.connection_id)
			and not public.qorpera_member_work_login_has_room(p_profile_id, p_requester, p_staff_agent_id, followed.connection_id)
	),
	-- The followed company account's bindings that can pay for this agent's work now: qorpera_company_account_sponsor's
	-- conditions, for that account whichever account the agent would take for new work.
	followed_company as (
		select binding.id as binding_id, sponsor.version, sponsor.created_at
		from followed
		join public.qorpera_provider_connections as connection on connection.id = followed.connection_id
		join public.qorpera_execution_sponsor_versions as sponsor on sponsor.provider_connection_id = connection.id
		join public.qorpera_execution_sponsor_bindings as binding on binding.id = sponsor.binding_id
		join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
			and version.version = sponsor.provider_connection_version
		join public.qorpera_profile_staff as staff on staff.profile_id = p_profile_id
			and staff.staff_agent_id = p_staff_agent_id and staff.employment_status = 'active'
		where followed.company and binding.profile_id = p_profile_id and binding.status = 'active'
			and sponsor.version = (select max(latest.version) from public.qorpera_execution_sponsor_versions as latest
				where latest.binding_id = binding.id)
			and sponsor.sponsor_kind <> 'member_connection' and sponsor.allow_autonomous
			and connection.profile_id = p_profile_id and connection.owner_user_id is null and connection.status = 'active'
			and connection.provider = coalesce(staff.model_provider, 'openai')
			and version.authorization_state = 'active' and version.allow_autonomous
			and version.native_harness <> 'claude-code'
			and not exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = connection.id and newer.version > version.version)
			and public.qorpera_provider_execution_enabled(connection.provider, version.authentication_mode, version.native_harness)
	)
	select candidate.binding_id, candidate.version from (
		-- Work that follows a run stays on that run's login while it has room (20260930059000), or on its company
		-- account. 20260930575000: on the requester's own login at its usage limit, or one that cannot pay now, it moves
		-- to their own login with the most room; with none, it stays (and waits for the reset) or, unable to pay, does not
		-- start.
		select own.binding_id, own.version, 1 as rank, own.binding_id = p_prefer_binding_id as preferred, own.created_at
		from own join followed on not followed.company and followed.connection_id = own.connection_id
		where not exists (select 1 from moved)
		union all
		select moved.binding_id, moved.version, 1, false, null::timestamptz
		from moved
		union all
		select company.binding_id, company.version, 1, company.binding_id = p_prefer_binding_id, company.created_at
		from followed_company as company
		union all
		-- New work: the requester's own login with the most room left (unknown usage after measured room), then their
		-- used-up login, whose limit stops the work; a company account only for a member with no login of their own.
		select ranked.binding_id, ranked.version, 2, false, ranked.created_at from (
			select own.binding_id, own.version, own.created_at
			from own where not exists (select 1 from followed)
			-- 20260930559000: a login that works and the most room on one scale, a used-up one after those.
			order by public.qorpera_native_account_rank(own.connection_id, own.connection_version), own.created_at desc,
				own.binding_id
			limit 1) as ranked
		union all
		select company.binding_id, company.version, 3, false, null::timestamptz
		from public.qorpera_company_account_sponsor(p_profile_id, p_staff_agent_id) as company
		where not exists (select 1 from followed) and not exists (select 1 from own)
	) as candidate
	order by candidate.rank, candidate.preferred desc, candidate.created_at desc nulls last, candidate.binding_id
	limit 1
$$;

-- 4. A routine ----------------------------------------------------------------------------------------------------------

-- The login a routine's run pays with: the routine's own; while that one is its member's own login at its usage limit or
-- unable to pay now, their own login with the most room, if one has room.
create function public.qorpera_routine_wake_payer(p_profile_id uuid, p_user_id uuid, p_staff_agent_id uuid,
	p_binding_id uuid, p_version bigint)
returns table(binding_id uuid, version bigint)
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	with paying as (
		select connection.id
		from public.qorpera_execution_sponsor_versions as sponsor
		join public.qorpera_provider_connections as connection on connection.id = sponsor.provider_connection_id
		where sponsor.binding_id = p_binding_id and sponsor.version = p_version and sponsor.sponsor_kind = 'member_connection'
			and connection.owner_user_id = p_user_id and connection.profile_id = p_profile_id
			and not public.qorpera_connection_is_chatgpt_plan(connection.id)
			and not public.qorpera_member_work_login_has_room(p_profile_id, p_user_id, p_staff_agent_id, connection.id)
	),
	moved as (
		select room.binding_id, room.version from paying
		cross join lateral public.qorpera_member_work_login_with_room(p_profile_id, p_user_id, p_staff_agent_id, paying.id) as room
	)
	select moved.binding_id, moved.version from moved
	union all
	select p_binding_id, p_version where not exists (select 1 from moved)
$$;

-- A routine's run may pay with another login of the routine's member, of the same provider, when the routine's own
-- payer is that member's login (never a company account's routine, never another member's login).
create function public.qorpera_routine_runs_on_own_login(p_version public.qorpera_cloud_routine_versions, p_binding_id uuid,
	p_sponsor_version bigint)
returns boolean
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select exists (select 1
		from public.qorpera_execution_sponsor_versions as routine_sponsor
		join public.qorpera_provider_connections as routine_connection
			on routine_connection.id = routine_sponsor.provider_connection_id
		join public.qorpera_execution_sponsor_versions as run_sponsor
			on run_sponsor.binding_id = p_binding_id and run_sponsor.version = p_sponsor_version
		join public.qorpera_execution_sponsor_bindings as run_binding on run_binding.id = run_sponsor.binding_id
		join public.qorpera_provider_connections as run_connection on run_connection.id = run_sponsor.provider_connection_id
		where routine_sponsor.binding_id = p_version.sponsor_binding_id and routine_sponsor.version = p_version.sponsor_version
			and routine_sponsor.sponsor_kind = 'member_connection' and run_sponsor.sponsor_kind = 'member_connection'
			and routine_connection.owner_user_id = p_version.created_by_user_id
			and run_connection.owner_user_id = p_version.created_by_user_id
			and run_binding.profile_id = p_version.profile_id and run_binding.status = 'active'
			and run_connection.profile_id = p_version.profile_id and routine_connection.profile_id = p_version.profile_id
			and run_connection.provider = routine_connection.provider)
$$;

revoke all on function public.qorpera_routine_wake_payer(uuid, uuid, uuid, uuid, bigint),
	public.qorpera_routine_runs_on_own_login(public.qorpera_cloud_routine_versions, uuid, bigint)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The pin trigger: a routine's run takes the login qorpera_routine_wake_payer gives; a moved run lends no pinned computer
-- (the routine's computer belongs to its own login's identity).
select pg_temp.as575_patch('public.qorpera_pin_wake_occurrence()'::regprocedure,
$old$		new.sponsor_binding_id := v_version.sponsor_binding_id;
		new.sponsor_version := public.qorpera_live_sponsor_version(v_version.sponsor_binding_id, v_version.sponsor_version);
		new.logical_computer_id := v_version.logical_computer_id;
$old$,
$new$		new.sponsor_binding_id := v_version.sponsor_binding_id;
		new.sponsor_version := public.qorpera_live_sponsor_version(v_version.sponsor_binding_id, v_version.sponsor_version);
		new.logical_computer_id := v_version.logical_computer_id;
		-- 20260930575000: while the routine's own login (its member's) is at its usage limit or cannot pay, the run pays
		-- with that member's own login with the most room.
		select payer.binding_id, payer.version into new.sponsor_binding_id, new.sponsor_version
		from public.qorpera_routine_wake_payer(new.profile_id, v_version.created_by_user_id, v_version.staff_agent_id,
			new.sponsor_binding_id, new.sponsor_version) as payer;
		if new.sponsor_binding_id is distinct from v_version.sponsor_binding_id then new.logical_computer_id := null; end if;
$new$);

-- The admission accepts that run.
select pg_temp.as575_patch('public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure,
$old$			and v.sponsor_binding_id = p_wake.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v.sponsor_binding_id, v.sponsor_version, v_standing_version)) then return false; end if;
$old$,
$new$			and ((v.sponsor_binding_id = p_wake.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v.sponsor_binding_id, v.sponsor_version, v_standing_version))
				-- 20260930575000: or another login of the routine's member, which took over at its own login's usage limit.
				or public.qorpera_routine_runs_on_own_login(v, p_wake.sponsor_binding_id, v_standing_version))) then return false; end if;
$new$);

-- So does the run's wake policy.
select pg_temp.as575_patch('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
$old$			and v.sponsor_binding_id = v_run.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v.sponsor_binding_id, v.sponsor_version,
				public.qorpera_wake_standing_sponsor_version(v_wake))
$old$,
$new$			and ((v.sponsor_binding_id = v_run.sponsor_binding_id
			and public.qorpera_sponsor_version_follows(v.sponsor_binding_id, v.sponsor_version,
				public.qorpera_wake_standing_sponsor_version(v_wake)))
				-- 20260930575000: or another login of the routine's member (qorpera_routine_wake_payer).
				or public.qorpera_routine_runs_on_own_login(v, v_run.sponsor_binding_id,
					public.qorpera_wake_standing_sponsor_version(v_wake)))
$new$);

-- The routine editor reads a routine whose runs take another of its member's logins as able to pay.
select pg_temp.as575_patch('public.qorpera_get_routine_payer(uuid)'::regprocedure,
$old$	v_waits := case when not public.qorpera_company_state_routine_paid(v_current) then 'login'
		else public.qorpera_company_state_routine_waits(v_connection.id) end;
$old$,
$new$	v_waits := case when not public.qorpera_company_state_routine_paid(v_current) then 'login'
		else public.qorpera_company_state_routine_waits(v_connection.id) end;
	-- 20260930575000: its runs pay with another of its member's logins meanwhile.
	if v_waits in ('usage_limit', 'sign_in') and exists (select 1 from public.qorpera_routine_wake_payer(v_routine.profile_id,
			v_current.created_by_user_id, v_current.staff_agent_id, v_current.sponsor_binding_id,
			public.qorpera_live_sponsor_version(v_current.sponsor_binding_id, v_current.sponsor_version)) as payer
		where payer.binding_id is distinct from v_current.sponsor_binding_id) then
		v_waits := null;
	end if;
$new$);

-- 5. A coding session ---------------------------------------------------------------------------------------------------

-- A coding turn that begins while its session's login (its owner's) is at its usage limit or cannot pay moves the session
-- to the owner's login with the most room first, as the owner's own pick does (qorpera_choose_coding_session_login, whose
-- candidates these are): the binding that pick would find or make, at its newest version, and the session's event. With
-- no login of the owner with room, nothing changes. The caller holds the worker and the session.
create function public.qorpera_coding_session_move_at_limit(p_worker public.qorpera_runtime_workers,
	p_session public.qorpera_coding_sessions)
returns public.qorpera_runtime_workers
language plpgsql security definer set search_path = '' as $$
declare v_worker public.qorpera_runtime_workers%rowtype := p_worker; v_current uuid; v_current_version bigint;
	v_login record; v_binding public.qorpera_execution_sponsor_bindings%rowtype;
	v_sponsor public.qorpera_execution_sponsor_versions%rowtype; v_client uuid;
begin
	-- 20260930575000
	if v_worker.owner_sponsor_binding_id is null or v_worker.owner_user_id is null then return v_worker; end if;
	select sponsor.provider_connection_id, sponsor.provider_connection_version into v_current, v_current_version
	from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = v_worker.owner_sponsor_binding_id
		and sponsor.version = public.qorpera_live_sponsor_version(v_worker.owner_sponsor_binding_id, v_worker.owner_sponsor_version);
	-- A login with room is kept; a ChatGPT plan's session is never moved to a login of another kind.
	if (public.qorpera_coding_session_login_state(v_worker) = 'ready' and v_current is not null
			and public.qorpera_native_account_remaining(v_current, v_current_version) <> 0)
		or public.qorpera_connection_is_chatgpt_plan(v_current) then
		return v_worker; end if;
	select candidate.connection_id, candidate.connection_version into v_login
	from public.qorpera_coding_session_login_candidates(v_worker, p_session.harness) as candidate
	where candidate.connection_id is distinct from v_current
		and public.qorpera_native_account_remaining(candidate.connection_id, candidate.connection_version) <> 0
	order by public.qorpera_native_account_rank(candidate.connection_id, candidate.connection_version), candidate.connection_id
	limit 1;
	if not found then return v_worker; end if;
	select sponsor.* into v_sponsor
	from public.qorpera_execution_sponsor_versions as sponsor
	join public.qorpera_execution_sponsor_bindings as binding on binding.id = sponsor.binding_id
	where binding.profile_id = v_worker.profile_id and binding.status = 'active' and sponsor.sponsor_kind = 'member_connection'
		and sponsor.provider_connection_id = v_login.connection_id and sponsor.provider_connection_version = v_login.connection_version
		and sponsor.created_by_user_id = v_worker.owner_user_id and sponsor.allow_autonomous
		and sponsor.version = (select max(later.version) from public.qorpera_execution_sponsor_versions as later
			where later.binding_id = binding.id)
	order by sponsor.created_at desc limit 1;
	if v_sponsor.binding_id is null then
		select (left(digest.hex, 8) || '-' || substr(digest.hex, 9, 4) || '-4' || substr(digest.hex, 14, 3) || '-8'
			|| substr(digest.hex, 18, 3) || '-' || substr(digest.hex, 21, 12))::uuid into v_client
		from (select encode(extensions.digest(convert_to('qorpera-coding-owner:' || v_login.connection_id::text || ':'
			|| v_login.connection_version::text, 'utf8'), 'sha256'), 'hex') as hex) as digest;
		select * into v_binding from public.qorpera_execution_sponsor_bindings
		where profile_id = v_worker.profile_id and client_binding_id = v_client for update;
		if v_binding.id is null then
			insert into public.qorpera_execution_sponsor_bindings (profile_id, client_binding_id, created_by_user_id)
			values (v_worker.profile_id, v_client, v_worker.owner_user_id) returning * into v_binding;
		elsif v_binding.created_by_user_id <> v_worker.owner_user_id or v_binding.status <> 'active' then
			return v_worker; end if;
		select sponsor.* into v_sponsor from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = v_binding.id order by sponsor.version desc limit 1;
		if v_sponsor.binding_id is null or v_sponsor.provider_connection_id <> v_login.connection_id
			or v_sponsor.provider_connection_version <> v_login.connection_version or not v_sponsor.allow_autonomous then
			insert into public.qorpera_execution_sponsor_versions (binding_id, version, sponsor_kind, provider_connection_id,
				provider_connection_version, allow_autonomous, created_by_user_id)
			values (v_binding.id, coalesce(v_sponsor.version, 0) + 1, 'member_connection', v_login.connection_id,
				v_login.connection_version, true, v_worker.owner_user_id)
			returning * into v_sponsor;
		end if;
	end if;
	update public.qorpera_runtime_workers set owner_sponsor_binding_id = v_sponsor.binding_id,
		owner_sponsor_version = v_sponsor.version, updated_at = clock_timestamp()
	where id = v_worker.id returning * into v_worker;
	perform public.qorpera_coding_event(v_worker.id, v_worker.sequence, 'step', 'kernel',
		jsonb_build_object('loginChosen', true, 'automatic', true, 'text', 'Moved to another login with room',
			'from', v_current, 'to', v_login.connection_id));
	return v_worker;
end
$$;
revoke all on function public.qorpera_coding_session_move_at_limit(public.qorpera_runtime_workers, public.qorpera_coding_sessions)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.as575_patch('public.qorpera_begin_coding_turn(uuid,uuid,jsonb)'::regprocedure,
$old$	select * into v_run from public.qorpera_execution_runs where id = v_worker.steering_run_id;
$old$,
$new$	-- 20260930575000: a session whose owner's login is at its usage limit or cannot pay takes their login with room.
	v_worker := public.qorpera_coding_session_move_at_limit(v_worker, v_session);
	select * into v_run from public.qorpera_execution_runs where id = v_worker.steering_run_id;
$new$);

-- 6. Waiting, and trying again at least once a day ----------------------------------------------------------------------

-- A usage limit's wall ends at the provider's reset, else 6 hours after the limit, and never later than a day after it.
select pg_temp.as575_patch('public.qorpera_native_account_usage_limit_reset_company(uuid)'::regprocedure,
	$old$coalesce(blocked.resets_at, blocked.observed_at + interval '6 hours')$old$,
	$new$least(coalesce(blocked.resets_at, blocked.observed_at + interval '6 hours'), blocked.observed_at + interval '1 day' /* 20260930575000 */)$new$,
	2);

-- A paused run comes back at that time too.
select pg_temp.as575_patch('public.qorpera_resume_run_from_log(uuid,text,boolean)'::regprocedure,
$old$		v_until := greatest(case when v_signal.resets_at > statement_timestamp() then v_signal.resets_at
			else v_signal.observed_at + interval '6 hours' end, statement_timestamp() + interval '1 minute');
$old$,
$new$		-- 20260930575000: and at the latest a day after the limit, to try again.
		v_until := greatest(least(case when v_signal.resets_at > statement_timestamp() then v_signal.resets_at
			else v_signal.observed_at + interval '6 hours' end, v_signal.observed_at + interval '1 day'),
			statement_timestamp() + interval '1 minute');
$new$);

-- The reset of a login at its usage limit by its newest usage reading (its account's, in every company): the latest reset
-- still ahead of a window at 100%. Null when no reading shows a full window.
create function public.qorpera_native_account_reading_reset(p_connection_id uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select max((w.value ->> 'resetAt')::timestamptz)
	from public.qorpera_native_account_login_connections(p_connection_id) as login
	join public.qorpera_native_provider_account_metadata as m on m.connection_id = login.connection_id
	cross join lateral jsonb_array_elements(case when jsonb_typeof(m.provider_account_usage -> 'windows') = 'array'
		then m.provider_account_usage -> 'windows' else '[]'::jsonb end) as w
	where jsonb_typeof(w.value -> 'usedPercent') = 'number' and (w.value ->> 'usedPercent')::numeric >= 100
		and jsonb_typeof(w.value -> 'resetAt') = 'string'
		and (w.value ->> 'resetAt')::timestamptz > clock_timestamp()
		and (w.value ->> 'resetAt')::timestamptz < clock_timestamp() + interval '90 days'
$$;

-- What the usage-limit notice adds for the member whose own login it is: that login's email and the login work moves to
-- (the conversation's choice, qorpera_member_session_login_with_room), or none. Nothing for a company account.
create function public.qorpera_usage_limit_moved_to(p_profile_id uuid, p_user_id uuid, p_connection_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
	-- 20260930575000
	select coalesce((select jsonb_build_object(
			'accountEmail', (select version.provider_account_email from public.qorpera_provider_connection_versions as version
				where version.connection_id = p_connection_id order by version.version desc limit 1),
			'movedTo', (select jsonb_build_object('connectionId', room.connection_id,
					'accountEmail', (select version.provider_account_email from public.qorpera_provider_connection_versions as version
						where version.connection_id = room.connection_id order by version.version desc limit 1))
				from public.qorpera_member_session_login_with_room(p_profile_id, p_user_id, p_connection_id) as room))
		from public.qorpera_provider_connections as connection
		where connection.id = p_connection_id and connection.owner_user_id = p_user_id), '{}'::jsonb)
$$;

revoke all on function public.qorpera_native_account_reading_reset(uuid), public.qorpera_usage_limit_moved_to(uuid, uuid, uuid)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

select pg_temp.as575_patch('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)'::regprocedure,
$old$		p_signal_kind,'native_adapter',p_resets_at,v_lease.assignment_id)
$old$,
$new$		-- 20260930575000: the provider names no reset with a usage limit; the login's newest usage reading may.
		p_signal_kind,'native_adapter',coalesce(p_resets_at, case when p_signal_kind = 'usage_limit'
			then public.qorpera_native_account_reading_reset(v_lease.provider_connection_id) end),v_lease.assignment_id)
$new$);
select pg_temp.as575_patch('public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)'::regprocedure,
$old$				'sponsorVersion',v_run.sponsor_version,'resetsAt',p_resets_at),
$old$,
$new$				'sponsorVersion',v_run.sponsor_version,'resetsAt',v_signal.resets_at)
				-- 20260930575000: which login reached its limit, and the member's login the work moves to.
				|| public.qorpera_usage_limit_moved_to(v_run.profile_id, v_recipient, v_connection.id),
$new$);

-- 7. What the agent and the session's card say ------------------------------------------------------------------------

-- The words a run at its usage limit gives its agent (20260930549300): the work moves, or waits and is tried again.
select pg_temp.as575_patch('public.qorpera_worker_usage_limit_text(uuid)'::regprocedure,
$old$	-- 20260930549300.
	select 'The login paying for this work reached its usage limit. '
		|| case when limit_reset.resets is null then ''
			else 'It resets on ' || to_char(limit_reset.resets at time zone 'UTC', 'FMDD FMMonth YYYY "at" HH24:MI "UTC"') || '. ' end
		|| 'The work does not move to another login by itself: the member can choose another of their logins for it '
		|| '(in the conversation''s Login menu), or wait until the limit resets.'
$old$,
$new$	-- 20260930549300. 20260930575000: the work moves to the member's own login with room, or waits and is tried again.
	select 'The login paying for this work reached its usage limit. '
		|| case when limit_reset.resets is null then ''
			else 'It resets on ' || to_char(limit_reset.resets at time zone 'UTC', 'FMDD FMMonth YYYY "at" HH24:MI "UTC"') || '. ' end
		|| 'The work moves by itself to another of the member''s own logins that has room. When none has room, it waits '
		|| 'and is tried again when the limit resets, at the latest a day later. The member can also choose another of '
		|| 'their logins for it (in the conversation''s Login menu).'
$new$);

-- A coding session's failed turn (20260930551000): its next turn moves to the owner's login with room by itself.
select pg_temp.as575_patch('public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'::regprocedure,
$old$	-- The same tail for every login reason: the payer never changes without the member (20260930059000).
	v_tail constant text := ' The session does not move to another login by itself: the member who owns it can choose '
		|| 'another of their logins for it on the coding session''s card in the conversation, then ask for the work again.';
$old$,
$new$	-- The same tail for every login reason. 20260930575000: the next turn moves to the owner's login with room by itself.
	v_tail constant text := ' The session moves by itself to another of its owner''s logins that has room when its next turn '
		|| 'begins. The owner can also choose another of their logins for it on the coding session''s card in the '
		|| 'conversation, then ask for the work again.';
$new$);

-- 8. The deploy guard ---------------------------------------------------------------------------------------------------

do $guard$
declare v_function regprocedure;
begin
	foreach v_function in array array[
		'public.qorpera_member_work_logins(uuid,uuid,uuid)', 'public.qorpera_member_work_login_with_room(uuid,uuid,uuid,uuid)',
		'public.qorpera_member_work_login_has_room(uuid,uuid,uuid,uuid)', 'public.qorpera_member_session_login_with_room(uuid,uuid,uuid)',
		'public.qorpera_select_member_session_account(uuid,uuid)', 'public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)',
		'public.qorpera_routine_wake_payer(uuid,uuid,uuid,uuid,bigint)',
		'public.qorpera_routine_runs_on_own_login(public.qorpera_cloud_routine_versions,uuid,bigint)',
		'public.qorpera_pin_wake_occurrence()', 'public.qorpera_folder_wake_authorized(public.qorpera_wake_occurrences)',
		'public.qorpera_runtime_wake_policy_internal(uuid)', 'public.qorpera_get_routine_payer(uuid)',
		'public.qorpera_coding_session_move_at_limit(public.qorpera_runtime_workers,public.qorpera_coding_sessions)',
		'public.qorpera_begin_coding_turn(uuid,uuid,jsonb)', 'public.qorpera_native_account_usage_limit_reset_company(uuid)',
		'public.qorpera_resume_run_from_log(uuid,text,boolean)', 'public.qorpera_native_account_reading_reset(uuid)',
		'public.qorpera_usage_limit_moved_to(uuid,uuid,uuid)',
		'public.qorpera_record_provider_usage_signal(jsonb,text,timestamp with time zone)',
		'public.qorpera_worker_usage_limit_text(uuid)', 'public.qorpera_coding_turn_failure(public.qorpera_runtime_workers,text)'
	]::regprocedure[] loop
		if strpos((select prosrc from pg_proc where oid = v_function), '20260930575000') = 0 then
			raise exception '20260930575000 marker is missing in %', v_function; end if;
	end loop;
end $guard$;
