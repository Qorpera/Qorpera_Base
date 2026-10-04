-- The payer never changes without the member (founder decision 2026-10-04).
--
-- "The system should never be able to swap what member pays without permission." Since 20260928349910 a run that
-- reaches its login's usage limit stops there instead of moving to another login. Yet the next unit of work still
-- moved on its own:
-- * a conversation whose login reached its limit took the member's other login with room left at its next message
--   (qorpera_select_member_session_account, then the web followed it);
-- * work that follows a run (a coworker's or a worker's wake, a review of the run's change, its retry) took the
--   starter's login with the most room left, then the company account, and only last the run's own login
--   (qorpera_starter_sponsor). ChatGPT plans alone stayed put (20260929950000, migration 20260928359950).
-- Now, for every kind of login, in these two choices:
-- * A conversation keeps its login, also at its usage limit (sending waits until it resets), while it needs a new
--   sign-in, while its computer is recovering and while an owner or admin has it disabled. Its binding still follows
--   the member to their new connection for the same account after they sign in again (qorpera_move_member_login_pins).
--   A conversation whose login the member disconnected (revoked) has no account until the member picks another by
--   hand (qorpera_choose_member_session_account, new): ending a login is no permission to use another. Only a new
--   conversation takes a first choice, the member's login with the most room left.
-- * Work that follows a run (qorpera_starter_sponsor's callers: coworker, worker and other agent wakes, a change's
--   review and its retry) stays on that run's login or company account, also at its usage limit, which then stops it
--   there. When that login or account can no longer pay at all (disconnected, or its consent to work while the member
--   is away switched off) nothing pays: the work does not start on another login or account.
-- * New work there (no run to follow) takes the requester's own login with the most room left, then their used-up
--   login (the work stops at its limit), and a company account only for a member with no login of their own. A
--   company account is never chosen because the member's login is at its limit.
-- * A member who signs in to the vault again with the same account gets a new connection, as every sign-in does; the
--   vault's upkeep pass now moves their pins from the older vault login of the same kind and account to it and
--   switches the old one off (qorpera_switch_off_replaced_node_logins, as it did for node logins), so what they started
--   follows the same account's new login.
-- * The usage-limit handoff (qorpera_handoff_run_sponsor), unreachable since 20260928349910, is dropped, with the two
--   helpers of the old plan-only rule. The handoff rows and readers stay until the run continuation goes; nothing
--   writes them any more.
-- Not here (open, contract section 17's 2026-10-04 amendment): a folder-v2 routine's payer at save
-- (qorpera_company_state_routine_payer), an agent-made routine's (qorpera_agent_routine_sponsor) and a coding worker's
-- (qorpera_coding_owner_sponsor) still choose among the member's logins and company accounts themselves.
--
-- Locks: none new. The conversation choice keeps its one row lock on the conversation; the payer functions only read.
-- Every new body carries the marker 20260930059000. Folder-v2 only: no compatibility path is kept.

do $$
begin
	if position('kept_plan' in pg_get_functiondef('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure)) = 0
		or position('v_saved_at_limit' in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) = 0
		or position('qorpera_native_account_remaining(connection.id,version.version) <> 0'
			in pg_get_functiondef('public.qorpera_eligible_member_accounts(uuid,uuid)'::regprocedure)) = 0 then
		raise exception 'A payer function changed after 20260928359950; rebase 20260930059000 on it';
	end if;
end $$;

-- A member's Codex logins that could pay for their conversations, whatever their usage: their own login on their own
-- active compute identity, with the newest binding they made for it. Usage is reported, never filtered.
create function public.qorpera_member_live_accounts(p_profile_id uuid, p_user_id uuid)
returns table(connection_id uuid, binding_id uuid, sponsor_version bigint, compute_identity_id uuid, remaining numeric)
language sql stable security definer set search_path = '' as $$
    -- 20260930059000: the conversation's login is kept from these at any usage.
    select connection.id,sponsor.binding_id,sponsor.version,identity.id,
        public.qorpera_native_account_remaining(connection.id,version.version)
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
        select candidate.* from public.qorpera_execution_sponsor_versions candidate
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
$$;
revoke all on function public.qorpera_member_live_accounts(uuid,uuid) from public,anon,authenticated,service_role;

-- The logins new work may start on: those with room left (unknown usage counts as room).
create or replace function public.qorpera_eligible_member_accounts(p_profile_id uuid, p_user_id uuid)
returns table(connection_id uuid, binding_id uuid, sponsor_version bigint, compute_identity_id uuid, remaining numeric)
language sql stable security definer set search_path = '' as $$
    -- 20260930059000: the live accounts with room left.
    select account.connection_id,account.binding_id,account.sponsor_version,account.compute_identity_id,account.remaining
    from public.qorpera_member_live_accounts(p_profile_id,p_user_id) account
    where account.remaining <> 0
$$;

create or replace function public.qorpera_select_member_session_account(p_profile_id uuid, p_session_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_saved public.qorpera_member_session_accounts%rowtype; v_choice record;
    v_current uuid;
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
        -- The payer never changes without the member (20260930059000): the conversation keeps its login, also at its
        -- usage limit, which stops the sending there until it resets. Its binding may pay with the member's new
        -- connection for the same account since they signed in again (qorpera_move_member_login_pins).
        v_current := coalesce(public.qorpera_sponsor_binding_connection(v_saved.sponsor_binding_id), v_saved.connection_id);
        select * into v_choice from public.qorpera_member_live_accounts(p_profile_id,v_user) candidate
            where candidate.connection_id = v_current
            order by (candidate.binding_id = v_saved.sponsor_binding_id) desc,candidate.binding_id limit 1;
        if found then
            update public.qorpera_member_session_accounts set connection_id = v_choice.connection_id,
                sponsor_binding_id = v_choice.binding_id,
                selected_at = case when connection_id = v_choice.connection_id then selected_at else clock_timestamp() end
            where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
            return v_choice.connection_id;
        end if;
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
    -- A new conversation's first choice: the member's login with the most room left; unknown usage sorts last.
    select * into v_choice from public.qorpera_eligible_member_accounts(p_profile_id,v_user) candidate
        order by candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1;
    if not found then return null; end if;
    insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
        values(p_profile_id,p_session_id,v_user,v_choice.connection_id,v_choice.binding_id)
        on conflict(profile_id,session_id,user_id) do update set
            connection_id = excluded.connection_id,sponsor_binding_id = excluded.sponsor_binding_id,
            selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
                then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
    return v_choice.connection_id;
end $$;

-- The member picks the login a conversation of theirs pays with, by hand: one of their own logins that could pay
-- (qorpera_member_live_accounts), whatever its usage. This is the member's permission the payer rule asks for; the
-- web offers it when the conversation's login was disconnected.
create function public.qorpera_choose_member_session_account(p_profile_id uuid, p_session_id uuid, p_connection_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_choice record;
begin
    if auth.role() is distinct from 'authenticated' or v_user is null
        or not public.qorpera_can_read_session(p_session_id) then
        raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    -- The same row lock as the automatic choice: one conversation's choices are serialized.
    perform 1 from public.qorpera_shared_sessions where id = p_session_id and profile_id = p_profile_id for update;
    if not found then raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    -- 20260930059000: only the member's own login that could pay.
    select * into v_choice from public.qorpera_member_live_accounts(p_profile_id,v_user) candidate
        where candidate.connection_id = p_connection_id
        order by candidate.binding_id limit 1;
    if not found then raise exception 'This login cannot pay for your conversation' using errcode = '22023'; end if;
    insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
        values(p_profile_id,p_session_id,v_user,v_choice.connection_id,v_choice.binding_id)
        on conflict(profile_id,session_id,user_id) do update set
            connection_id = excluded.connection_id,sponsor_binding_id = excluded.sponsor_binding_id,
            selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
                then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
    return v_choice.connection_id;
end $$;
revoke all on function public.qorpera_choose_member_session_account(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.qorpera_choose_member_session_account(uuid,uuid,uuid) to authenticated;

-- Who pays for work a member started. Never another member's login, and never a Claude login (coding only,
-- 2026-09-24).
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
			public.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at
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
		-- The payer never changes without the member (20260930059000): work that follows a run stays on that run's login
		-- or company account, also at its usage limit, which then stops it there. When that login or account cannot pay
		-- any more, nothing does.
		select own.binding_id, own.version, 1 as rank, own.binding_id = p_prefer_binding_id as preferred, own.created_at
		from own join followed on not followed.company and followed.connection_id = own.connection_id
		union all
		select company.binding_id, company.version, 1, company.binding_id = p_prefer_binding_id, company.created_at
		from followed_company as company
		union all
		-- New work: the requester's own login with the most room left (unknown usage after measured room), then their
		-- used-up login, whose limit stops the work; a company account only for a member with no login of their own.
		select ranked.binding_id, ranked.version, 2, false, ranked.created_at from (
			select own.binding_id, own.version, own.created_at
			from own where not exists (select 1 from followed)
			order by own.remaining = 0, own.remaining desc, own.created_at desc, own.binding_id
			limit 1) as ranked
		union all
		select company.binding_id, company.version, 3, false, null::timestamptz
		from public.qorpera_company_account_sponsor(p_profile_id, p_staff_agent_id) as company
		where not exists (select 1 from followed) and not exists (select 1 from own)
	) as candidate
	order by candidate.rank, candidate.preferred desc, candidate.created_at desc nulls last, candidate.binding_id
	limit 1
$$;

-- Vault re-sign-in moves the member's pins (review of #806, F1). Every sign-in makes a new connection, so a member who
-- signs in to the vault again with the same ChatGPT account (a vault login that needs a new sign-in, or a second one)
-- gets a new connection beside the old one. The vault's upkeep pass (qorpera_switch_off_replaced_node_logins) already
-- moves a member's pins from an old node login to their vault login of the same account and then switches the old one
-- off as Disconnect does; it now does the same for an older vault login of the same kind and account. Conversations,
-- follow-up work and routines then follow their bindings to the new connection: the same account pays, so this is no
-- change of payer. The move keeps consent: a binding that may work while its member is away moves only to a login
-- that may too (qorpera_move_member_login_pins), so a ChatGPT plan waits until its member turns that on again.
create function pg_temp.payer_never_swaps_replace(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930059000 anchor found % time(s) in %, expected 1',
			(length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old), p_target; end if;
	execute replace(v_definition, p_old, p_new);
end $$;
select pg_temp.payer_never_swaps_replace('public.qorpera_switch_off_replaced_node_logins(uuid,text)'::regprocedure,
$old$		for v_pair in
			select distinct on (node.id) node.id as old_connection_id, vault_connection.id as new_connection_id,
				vault_connection.owner_user_id as member_id
			from public.qorpera_model_logins as login
			join public.qorpera_native_credential_capsules as pointer on pointer.id = login.credential_capsule_id
			join public.qorpera_provider_connection_versions as vault_version on vault_version.credential_capsule_id = pointer.id
			join public.qorpera_provider_connections as vault_connection on vault_connection.id = vault_version.connection_id
			join public.qorpera_provider_connections as node on node.profile_id = vault_connection.profile_id
				and node.owner_user_id = vault_connection.owner_user_id and node.id <> vault_connection.id
			join lateral (
				select version.* from public.qorpera_provider_connection_versions as version
				where version.connection_id = node.id order by version.version desc limit 1
			) as node_version on true
			join public.qorpera_native_credential_capsules as node_capsule on node_capsule.id = node_version.credential_capsule_id
			where login.broker_authority_id = v_authority.id and login.profile_id = v_authority.profile_id
				and login.status = 'active' and login.account_identity is not null
				and pointer.status = 'active' and pointer.encrypted_capsule_reference = 'model-login/' || login.id::text
				and vault_connection.status = 'active' and vault_connection.profile_id = login.profile_id
				and vault_connection.owner_user_id is not null
				and vault_version.authorization_state = 'active'
				and vault_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
					where latest.connection_id = vault_connection.id)
				and node.status = 'active' and node.provider = 'openai' and node.created_at < vault_connection.created_at
				and node_version.authentication_mode = 'native_subscription' and node_version.native_harness = 'codex-cli'
				and node_version.authorization_state = 'active'
				and node_capsule.status = 'active' and node_capsule.encrypted_capsule_reference !~ '^model-login/'
				-- The account recorded for the node's current login (a version using the capsule the latest
				-- version uses), never one recorded for an earlier login of the connection.
				and exists (select 1 from public.qorpera_native_provider_account_metadata as seen
					join public.qorpera_provider_connection_versions as seen_version
						on seen_version.connection_id = seen.connection_id and seen_version.version = seen.connection_version
					where seen.connection_id = node.id and seen_version.credential_capsule_id = node_version.credential_capsule_id
						and seen.provider_account_identity = login.account_identity)
			order by node.id, vault_connection.created_at desc, vault_connection.id
			limit 4
		loop
$old$,
$new$		for v_pair in
			select pair.old_connection_id, pair.new_connection_id, pair.member_id from ((
				select distinct on (node.id) node.id as old_connection_id, vault_connection.id as new_connection_id,
					vault_connection.owner_user_id as member_id
				from public.qorpera_model_logins as login
				join public.qorpera_native_credential_capsules as pointer on pointer.id = login.credential_capsule_id
				join public.qorpera_provider_connection_versions as vault_version on vault_version.credential_capsule_id = pointer.id
				join public.qorpera_provider_connections as vault_connection on vault_connection.id = vault_version.connection_id
				join public.qorpera_provider_connections as node on node.profile_id = vault_connection.profile_id
					and node.owner_user_id = vault_connection.owner_user_id and node.id <> vault_connection.id
				join lateral (
					select version.* from public.qorpera_provider_connection_versions as version
					where version.connection_id = node.id order by version.version desc limit 1
				) as node_version on true
				join public.qorpera_native_credential_capsules as node_capsule on node_capsule.id = node_version.credential_capsule_id
				where login.broker_authority_id = v_authority.id and login.profile_id = v_authority.profile_id
					and login.status = 'active' and login.account_identity is not null
					and pointer.status = 'active' and pointer.encrypted_capsule_reference = 'model-login/' || login.id::text
					and vault_connection.status = 'active' and vault_connection.profile_id = login.profile_id
					and vault_connection.owner_user_id is not null
					and vault_version.authorization_state = 'active'
					and vault_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
						where latest.connection_id = vault_connection.id)
					and node.status = 'active' and node.provider = 'openai' and node.created_at < vault_connection.created_at
					and node_version.authentication_mode = 'native_subscription' and node_version.native_harness = 'codex-cli'
					and node_version.authorization_state = 'active'
					and node_capsule.status = 'active' and node_capsule.encrypted_capsule_reference !~ '^model-login/'
					-- The account recorded for the node's current login (a version using the capsule the latest
					-- version uses), never one recorded for an earlier login of the connection.
					and exists (select 1 from public.qorpera_native_provider_account_metadata as seen
						join public.qorpera_provider_connection_versions as seen_version
							on seen_version.connection_id = seen.connection_id and seen_version.version = seen.connection_version
						where seen.connection_id = node.id and seen_version.credential_capsule_id = node_version.credential_capsule_id
							and seen.provider_account_identity = login.account_identity)
				order by node.id, vault_connection.created_at desc, vault_connection.id
			) union all (
				-- 20260930059000: the member signed in to the vault again with the same ChatGPT account (a vault login that
				-- needs a new sign-in, or a second one): a new connection for the same account, as every sign-in makes. The
				-- older vault login of the same kind is replaced the same way, so the member's pins follow their account.
				select distinct on (old_connection.id) old_connection.id as old_connection_id,
					vault_connection.id as new_connection_id, vault_connection.owner_user_id as member_id
				from public.qorpera_model_logins as login
				join public.qorpera_native_credential_capsules as pointer on pointer.id = login.credential_capsule_id
				join public.qorpera_provider_connection_versions as vault_version on vault_version.credential_capsule_id = pointer.id
				join public.qorpera_provider_connections as vault_connection on vault_connection.id = vault_version.connection_id
				join public.qorpera_provider_connections as old_connection on old_connection.profile_id = vault_connection.profile_id
					and old_connection.owner_user_id = vault_connection.owner_user_id and old_connection.id <> vault_connection.id
				join lateral (
					select version.* from public.qorpera_provider_connection_versions as version
					where version.connection_id = old_connection.id order by version.version desc limit 1
				) as old_version on true
				join public.qorpera_native_credential_capsules as old_pointer on old_pointer.id = old_version.credential_capsule_id
				join public.qorpera_model_logins as old_login on old_login.credential_capsule_id = old_pointer.id
					and old_pointer.encrypted_capsule_reference = 'model-login/' || old_login.id::text
				where login.broker_authority_id = v_authority.id and login.profile_id = v_authority.profile_id
					and login.status = 'active' and login.account_identity is not null
					and pointer.status = 'active' and pointer.encrypted_capsule_reference = 'model-login/' || login.id::text
					and vault_connection.status = 'active' and vault_connection.profile_id = login.profile_id
					and vault_connection.owner_user_id is not null
					and vault_version.authorization_state = 'active'
					and vault_version.version = (select max(latest.version) from public.qorpera_provider_connection_versions as latest
						where latest.connection_id = vault_connection.id)
					and old_connection.status = 'active' and old_connection.provider = 'openai'
					and old_connection.created_at < vault_connection.created_at
					and old_version.authentication_mode = 'native_subscription' and old_version.native_harness = 'codex-cli'
					and old_version.authorization_state = 'active' and old_pointer.status = 'active'
					and old_login.profile_id = login.profile_id and old_login.status in ('active', 'needs_sign_in')
					and old_login.login_kind = login.login_kind and old_login.account_identity = login.account_identity
				order by old_connection.id, vault_connection.created_at desc, vault_connection.id
			)) as pair
			order by pair.old_connection_id
			limit 4
		loop
$new$);

drop function public.qorpera_handoff_run_sponsor(uuid, text);
drop function public.qorpera_connection_at_limit(uuid);
drop function public.qorpera_member_plan_connection_usable(uuid, uuid, uuid);
