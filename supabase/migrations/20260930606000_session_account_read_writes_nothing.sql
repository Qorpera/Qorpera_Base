-- Asking which login pays for a conversation no longer works out how much room each login has, and writes nothing when
-- nothing changes (perf sprint 7 Nov 2026, measure A6).
--
-- Measured on production, 3 to 7 Nov: qorpera_select_member_session_account was by far the slowest call of opening a
-- thread: 18,263 calls, 47.9 ms mean, up to 102 ms in the quiet window of 7 Nov 05:30Z to 05:52Z (14 % of all database
-- time there), 2.1 WAL records and 8,774 buffers per call. The web asks when a thread opens and every 30 s while one is
-- open, in a hidden tab too. One call on production: 100 ms of the 102 ms is qorpera_member_live_accounts, and 96 ms of
-- that is qorpera_native_account_remaining for each login. This function reads only the connection and its binding from
-- that answer, never the room. It also took the conversation's row FOR UPDATE, so each poll blocked writers of the row for
-- as long as it ran, and rewrote its saved row with the same values.
--
-- Nothing changes in what any function answers (test 1106 compares the old and the new text):
-- 1. qorpera_member_live_account_bindings holds the rule of who is live; qorpera_member_live_accounts is that plus the room.
-- 2. qorpera_select_member_session_account reads the bindings without the room.
-- 3. It decides without a lock. When the saved row is already what it would write, it answers and writes nothing. When it
--    would write, it takes the conversation's row, as before, and decides again under the lock. Tabs still serialize every
--    change; a read that lands beside a change answers as if it had come just before it.
-- A new conversation's first choice still asks for the room, under the lock (qorpera_eligible_member_accounts).
-- Authority is untouched: the role, qorpera_can_read_session and the profile's own check come first, as before.
-- Undo: restore the two functions' text (20260930548000 for the live accounts, 20260930580000 for the selection) and drop
-- qorpera_member_live_account_bindings.

set local lock_timeout = '3s';

do $$
begin
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure),
		'20260930580000') = 0 then
		raise exception '20260930606000 needs 20260930580000'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_member_live_accounts(uuid,uuid)'::regprocedure),
		'20260930548000') = 0 then
		raise exception '20260930606000 needs 20260930548000'; end if;
	if strpos((select prosrc from pg_proc where oid = 'public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure),
		'20260930606000') > 0 then
		raise exception '20260930606000 is already applied'; end if;
end $$;

-- 1. Who is live: the rule of qorpera_member_live_accounts (20260930059000, 20260930548000), without the room.
create function public.qorpera_member_live_account_bindings(p_profile_id uuid, p_user_id uuid)
returns table(connection_id uuid, connection_version bigint, binding_id uuid, sponsor_version bigint, compute_identity_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
    -- 20260930606000: PL/pgSQL, so the session keeps the plan.
    return query
    select connection.id,version.version,sponsor.binding_id,sponsor.version,identity.id
    from public.qorpera_member_compute_identities identity
    join public.qorpera_native_credential_capsules capsule on capsule.compute_identity_id = identity.id
        and capsule.status = 'active' and capsule.ownership_kind = 'member' and capsule.owner_user_id = p_user_id
    join public.qorpera_provider_connection_versions version on version.credential_capsule_id = capsule.id
        and version.authentication_mode = 'native_subscription' and version.authorization_state = 'active'
        and not exists (select 1 from public.qorpera_provider_connection_versions newer
            where newer.connection_id = version.connection_id and newer.version > version.version)
    join public.qorpera_provider_connections connection on connection.id = version.connection_id
        and connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id and connection.status = 'active'
    join lateral (
        select candidate.binding_id,candidate.version from public.qorpera_execution_sponsor_versions candidate
        join public.qorpera_execution_sponsor_bindings binding on binding.id = candidate.binding_id
            and binding.profile_id = p_profile_id and binding.created_by_user_id = p_user_id and binding.status = 'active'
        where candidate.provider_connection_id = connection.id and candidate.provider_connection_version = version.version
            and candidate.sponsor_kind = 'member_connection'
            and not exists (select 1 from public.qorpera_execution_sponsor_versions newer
                where newer.binding_id = candidate.binding_id and newer.version > candidate.version)
        order by candidate.created_at desc,candidate.version desc limit 1
    ) sponsor on true
    where identity.profile_id = p_profile_id and identity.ownership_kind = 'member'
        and identity.owner_user_id = p_user_id and identity.status = 'active' and identity.recovery_pending_id is null
        and connection.provider = 'openai' and version.native_harness = 'codex-cli'
        and public.qorpera_provider_execution_enabled(connection.provider,'native_subscription',version.native_harness)
        and exists (select 1 from public.qorpera_profile_members member where member.profile_id = p_profile_id
            and member.user_id = p_user_id and member.role in ('owner','admin','contributor'))
        -- 20260930548000: an account login's link only while account logins are on, in a company its vault serves.
        and (not exists (select 1 from public.qorpera_model_login_links link where link.credential_capsule_id = capsule.id)
            or exists (select 1 from public.qorpera_model_login_links link
                join public.qorpera_model_logins login on login.id = link.login_id
                where link.credential_capsule_id = capsule.id and link.profile_id = p_profile_id
                    and link.owner_user_id = p_user_id and login.owner_user_id = p_user_id
                    and login.principal_id = public.qorpera_company_account_vault(p_profile_id)
                    and public.qorpera_account_model_logins_enabled()));
end $$;
revoke all on function public.qorpera_member_live_account_bindings(uuid,uuid)
	from public, anon, authenticated, service_role;

create or replace function public.qorpera_member_live_accounts(p_profile_id uuid, p_user_id uuid)
returns table(connection_id uuid, binding_id uuid, sponsor_version bigint, compute_identity_id uuid, remaining numeric)
language sql stable security definer set search_path = '' as $$
    -- 20260930059000: the conversation's login is kept from these at any usage.
    -- 20260930548000, 20260930606000: who is live is qorpera_member_live_account_bindings; this adds the room.
    select live.connection_id,live.binding_id,live.sponsor_version,live.compute_identity_id,
        public.qorpera_native_account_remaining(live.connection_id,live.connection_version)
    from public.qorpera_member_live_account_bindings(p_profile_id,p_user_id) as live
$$;

-- 2 and 3. The conversation's login.
create or replace function public.qorpera_select_member_session_account(p_profile_id uuid, p_session_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_saved public.qorpera_member_session_accounts%rowtype; v_choice record;
    v_current uuid; v_has_saved boolean; v_has_choice boolean; v_locked boolean := false;
begin
    if auth.role() is distinct from 'authenticated' or v_user is null
        or not public.qorpera_can_read_session(p_session_id) then
        raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    perform 1 from public.qorpera_shared_sessions where id = p_session_id and profile_id = p_profile_id;
    if not found then raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    -- 20260930606000: the web asks this every 30 s while a thread is open. The first pass only reads: when the saved row
    -- is already right it answers, with no lock and no write. A pass that would write takes the row and decides again.
    <<decide>>
    loop
        select * into v_saved from public.qorpera_member_session_accounts
            where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
        v_has_saved := found;
        -- 20260930580000: the login the member's own turn here waits on, at its usage limit, is the conversation's: the
        -- thread says so and offers their other logins by hand.
        select candidate.connection_id,candidate.binding_id into v_choice
            from public.qorpera_member_session_waiting_turns(p_profile_id,p_session_id,v_user) as waiting
            join public.qorpera_member_live_account_bindings(p_profile_id,v_user) as candidate
                on candidate.connection_id = waiting.connection_id
            order by waiting.created_at,waiting.request_id,candidate.binding_id limit 1;
        v_has_choice := found;
        if not v_has_choice and v_has_saved then
            -- The payer never changes without the member (20260930059000): the conversation keeps its login, also at its
            -- usage limit, which stops the sending there until it resets. Its binding may pay with the member's new
            -- connection for the same account since they signed in again (qorpera_move_member_login_pins).
            v_current := coalesce(public.qorpera_sponsor_binding_connection(v_saved.sponsor_binding_id), v_saved.connection_id);
            select candidate.connection_id,candidate.binding_id into v_choice
                from public.qorpera_member_live_account_bindings(p_profile_id,v_user) candidate
                where candidate.connection_id = v_current
                order by (candidate.binding_id = v_saved.sponsor_binding_id) desc,candidate.binding_id limit 1;
            v_has_choice := found;
            if not v_has_choice then
                -- A login that cannot pay right now (a new sign-in needed, its computer recovering, consent or the provider
                -- switched off, an owner or admin's reversible disable) stays the conversation's, and sending waits for it.
                -- A login the member disconnected (revoked) leaves the conversation with no account until the member picks
                -- one by hand (qorpera_choose_member_session_account): ending a login is no permission to use another.
                if exists (select 1 from public.qorpera_provider_connections connection where connection.id = v_current
                    and connection.profile_id = p_profile_id and connection.owner_user_id = v_user and connection.status <> 'revoked') then
                    return v_current;
                end if;
                return null;
            end if;
        end if;
        if v_has_choice and v_has_saved and v_saved.connection_id = v_choice.connection_id
            and v_saved.sponsor_binding_id = v_choice.binding_id then
            return v_choice.connection_id;
        end if;
        exit decide when v_locked;
        -- Serialize initial selection and replacement across this conversation's tabs.
        perform 1 from public.qorpera_shared_sessions where id = p_session_id and profile_id = p_profile_id for update;
        if not found then raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
        v_locked := true;
    end loop;
    if not v_has_choice then
        -- A new conversation's first choice: the member's login with the most room left; unknown usage sorts last.
        select candidate.connection_id,candidate.binding_id into v_choice
            from public.qorpera_eligible_member_accounts(p_profile_id,v_user) candidate
            -- 20260930559000: a login that works and the most room on one scale (qorpera_native_account_rank).
            order by public.qorpera_native_account_rank(candidate.connection_id, (select max(version.version)
                    from public.qorpera_provider_connection_versions as version
                    where version.connection_id = candidate.connection_id)),
                candidate.connection_id,candidate.binding_id limit 1;
        if not found then return null; end if;
    end if;
    insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
        values(p_profile_id,p_session_id,v_user,v_choice.connection_id,v_choice.binding_id)
        on conflict(profile_id,session_id,user_id) do update set
            connection_id = excluded.connection_id,sponsor_binding_id = excluded.sponsor_binding_id,
            selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
                then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
    return v_choice.connection_id;
end $$;
