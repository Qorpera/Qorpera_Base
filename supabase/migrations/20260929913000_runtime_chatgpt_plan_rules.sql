-- Sign in with ChatGPT, slice 1b (founder decisions 2026-10-01): the rules a member's ChatGPT plan login
-- keeps, built switched off with the rest of the login kind (20260928329830).
--
-- OpenAI's terms for plan use: the member's own plan pays only for work that member starts; no other
-- member's activity triggers calls on it; accounts are never pooled or rotated around a usage limit.
-- So, for a plan login:
-- 1. Work while the member is away needs their own consent. The kernel never consents a plan login for
--    them (qorpera_ensure_unattended_sponsor auto-consented a member's newest login for agent routines).
--    Without consent an agent's routine waits for a payer, as for a member with no login.
-- 2. It never pays for a listener: a file change or an event (webhooks, mail) is anyone's activity. Refused
--    when the routine is saved, and when it wakes, also for every wake that follows from a listener run (a
--    coworker message, a worker), and after a routine's login moved to a plan.
-- 3. It is never swapped at its usage limit, and it pays for follow-up work only of runs it pays for: a
--    conversation it pays for keeps it, follow-up work of a run it pays for keeps it (qorpera_starter_sponsor,
--    and so a review's seed, a coworker's or a worker's wake, a retried review), and no work another payer
--    started moves to a plan: not a listener run's, not a login's at its limit. A coding worker takes the
--    member's other login before a plan, and a plan only when the asking run is paid by it. A member
--    connects one plan per company (no pooling or rotating). A run in progress is never handed to another
--    login since #601; the handoff function itself stays as it is (test 658 pins it).
-- 4. Only the member whose plan pays retries a failed run on it, or a change's review.
-- 5. Plan use stops for a company being deleted (qorpera_chatgpt_plan_allowed).
-- Codex logins are unchanged by this migration, but for one tie: a review's retry prefers the review's
-- own payer among logins with room.
--
-- Each function is patched by exact text, once (the marker 20260929913000 skips a replay); a source that differs
-- stops the migration. Locks: one per-member advisory lock while a plan sign-in completes (no company-wide
-- lock); the helpers read a login's kind by its capsule (unique index).

set local lock_timeout = '3s';

-- Whether a provider connection holds a member's ChatGPT plan login: its capsule is a plan login's.
create or replace function public.qorpera_connection_is_chatgpt_plan(p_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_provider_connection_versions as version
		join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
		where version.connection_id = p_connection_id and login.login_kind = 'chatgpt_plan')
$$;

-- Whether a sponsor version pays with a ChatGPT plan login.
create or replace function public.qorpera_sponsor_version_is_chatgpt_plan(p_binding_id uuid, p_version bigint)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select public.qorpera_connection_is_chatgpt_plan(sponsor.provider_connection_id)
		from public.qorpera_execution_sponsor_versions as sponsor
		where sponsor.binding_id = p_binding_id and sponsor.version = p_version), false)
$$;

-- A ChatGPT plan login its member has not turned on for work while they are away: its newest version
-- carries no consent.
create or replace function public.qorpera_connection_plan_awaits_consent(p_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select public.qorpera_connection_is_chatgpt_plan(p_connection_id)
		and not coalesce((select version.allow_autonomous from public.qorpera_provider_connection_versions as version
			where version.connection_id = p_connection_id order by version.version desc limit 1), false)
$$;

revoke all on function public.qorpera_connection_is_chatgpt_plan(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_sponsor_version_is_chatgpt_plan(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_connection_plan_awaits_consent(uuid) from public, anon, authenticated, service_role;

-- The provider connection a binding's newest version pays with.
create or replace function public.qorpera_sponsor_binding_connection(p_binding_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
	select sponsor.provider_connection_id from public.qorpera_execution_sponsor_versions as sponsor
	where sponsor.binding_id = p_binding_id order by sponsor.version desc limit 1
$$;

-- Whether a connection's newest version is at its usage limit.
create or replace function public.qorpera_connection_at_limit(p_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce(public.qorpera_native_account_remaining(p_connection_id,
		(select max(version.version) from public.qorpera_provider_connection_versions as version
			where version.connection_id = p_connection_id)) = 0, false)
$$;

-- Whether a member's ChatGPT plan connection can still pay: what qorpera_eligible_member_accounts asks of an
-- account (the member's own active connection, identity and capsule, the member's role, the provider policy),
-- with its plan login signed in, at any usage.
create or replace function public.qorpera_member_plan_connection_usable(p_profile_id uuid, p_user_id uuid,
	p_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_provider_connections as connection
		join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
			and version.authentication_mode = 'native_subscription' and version.authorization_state = 'active'
			and version.native_harness = 'codex-cli'
			and not exists (select 1 from public.qorpera_provider_connection_versions as newer
				where newer.connection_id = version.connection_id and newer.version > version.version)
		join public.qorpera_native_credential_capsules as capsule on capsule.id = version.credential_capsule_id
			and capsule.status = 'active' and capsule.ownership_kind = 'member' and capsule.owner_user_id = p_user_id
		join public.qorpera_member_compute_identities as identity on identity.id = capsule.compute_identity_id
			and identity.profile_id = p_profile_id and identity.status = 'active' and identity.recovery_pending_id is null
		join public.qorpera_model_logins as login on login.credential_capsule_id = capsule.id
			and login.login_kind = 'chatgpt_plan' and login.status = 'active'
		where connection.id = p_connection_id and connection.profile_id = p_profile_id
			and connection.owner_user_id = p_user_id and connection.status = 'active'
			and public.qorpera_provider_execution_enabled(connection.provider, 'native_subscription', version.native_harness)
			and exists (select 1 from public.qorpera_profile_members as member where member.profile_id = p_profile_id
				and member.user_id = p_user_id and member.role in ('owner', 'admin', 'contributor')))
$$;

-- Whether a member already holds a usable ChatGPT plan login on another connection in this company. A plan
-- login that needs a new sign-in cannot pay, so signing in again (on a new connection) stays possible.
create or replace function public.qorpera_member_other_plan_connection(p_profile_id uuid, p_user_id uuid,
	p_client_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select exists (select 1 from public.qorpera_provider_connections as connection
		join public.qorpera_provider_connection_versions as version on version.connection_id = connection.id
		join public.qorpera_model_logins as login on login.credential_capsule_id = version.credential_capsule_id
		where connection.profile_id = p_profile_id and connection.owner_user_id = p_user_id
			and connection.status <> 'revoked' and connection.client_connection_id <> p_client_connection_id
			and login.login_kind = 'chatgpt_plan' and login.status = 'active')
$$;

-- The wakes anyone may cause: a file change, an event (a webhook, mail).
create or replace function public.qorpera_listener_source(p_source_kind text)
returns boolean language sql immutable set search_path = '' as $$
	select p_source_kind in ('company-file', 'event')
$$;

-- Whether a run follows, through its wakes' parent runs, from a file-change or event wake. A chain longer
-- than 64 runs counts as one (a plan is refused rather than the walk continued).
create or replace function public.qorpera_run_follows_listener(p_run_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_run uuid := p_run_id; v_source text; v_parent uuid;
begin
	for v_depth in 1 .. 64 loop
		if v_run is null then return false; end if;
		select wake.source_kind, wake.parent_run_id into v_source, v_parent
		from public.qorpera_wake_occurrences as wake where wake.run_id = v_run;
		if not found then return false; end if;
		if public.qorpera_listener_source(v_source) then return true; end if;
		v_run := v_parent;
	end loop;
	return true;
end
$$;

revoke all on function public.qorpera_sponsor_binding_connection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_connection_at_limit(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_member_plan_connection_usable(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_member_other_plan_connection(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_run_follows_listener(uuid) from public, anon, authenticated, service_role;
revoke all on function public.qorpera_listener_source(text) from public, anon, authenticated, service_role;

-- Plan use stops for a company being deleted.
create or replace function public.qorpera_chatgpt_plan_allowed(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select settings.enabled from public.qorpera_chatgpt_plan_settings as settings), false)
		and exists (select 1 from public.qorpera_chatgpt_plan_companies as company where company.profile_id = p_profile_id)
		and public.qorpera_model_login_sign_in_url(p_profile_id) is not null
		-- Sign in with ChatGPT, 20260929913000: not while the company is being deleted.
		and not public.qorpera_company_deleting(p_profile_id)
$$;

create function pg_temp.qorpera_plan_rules_20260929913000_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target); v_count integer;
begin
	if position('20260929913000' in v_definition) > 0 then return; end if;
	for v_index in 1 .. array_length(p_pairs, 1) / 2 loop
		v_count := (length(v_definition) - length(replace(v_definition, p_pairs[2 * v_index - 1], '')))
			/ length(p_pairs[2 * v_index - 1]);
		if v_count <> 1 then
			raise exception '% source differs (anchor % matches % times)', p_target, v_index, v_count; end if;
		v_definition := replace(v_definition, p_pairs[2 * v_index - 1], p_pairs[2 * v_index]);
	end loop;
	if position('20260929913000' in v_definition) = 0 then raise exception '% patch has no marker', p_target; end if;
	execute v_definition;
end
$patch$;

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_ensure_unattended_sponsor(public.qorpera_execution_runs)'::regprocedure, array[
	$a0$		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
$a0$,
	$r0$		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
		-- A member's ChatGPT plan works while they are away only once they turned that on themselves: it is
		-- never consented for them here (Sign in with ChatGPT, 20260929913000).
		and not public.qorpera_connection_plan_awaits_consent(connection.id)
$r0$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_activate_company_file_listener()'::regprocedure, array[
	$a0$	if jsonb_array_length(new.triggers) <> 1 then
		raise exception 'A listener cannot also be a schedule' using errcode = '22023'; end if;
$a0$,
	$r0$	if jsonb_array_length(new.triggers) <> 1 then
		raise exception 'A listener cannot also be a schedule' using errcode = '22023'; end if;
	-- A ChatGPT plan pays only for work its member starts: never for a file change or an event anyone may
	-- cause (Sign in with ChatGPT, 20260929913000).
	if public.qorpera_sponsor_version_is_chatgpt_plan(new.sponsor_binding_id, new.sponsor_version) then
		raise exception 'A ChatGPT plan cannot pay for a listener' using errcode = '42501'; end if;
$r0$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure, array[
	$a0$	if public.qorpera_environment_is_folder_v2(p_wake.environment_id) then return public.qorpera_folder_wake_authorized(p_wake); end if;
$a0$,
	$r0$	if public.qorpera_environment_is_folder_v2(p_wake.environment_id) then return public.qorpera_folder_wake_authorized(p_wake); end if;
	-- A ChatGPT plan never pays for a file change or an event anyone may cause, nor for any work that follows
	-- from one (a coworker message, a worker), also after a routine's login moved to a plan login (Sign in
	-- with ChatGPT, 20260929913000; a folder company takes neither wake at all).
	if public.qorpera_sponsor_version_is_chatgpt_plan(p_wake.sponsor_binding_id, p_wake.sponsor_version)
		and (public.qorpera_listener_source(p_wake.source_kind)
			or public.qorpera_run_follows_listener(p_wake.parent_run_id)) then
		return false; end if;
$r0$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure, array[
	$a0$			public.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at
$a0$,
	$r0$			public.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at,
			-- Sign in with ChatGPT (20260929913000): the ChatGPT plan that pays for the run stays the payer of its
			-- follow-up work, also at its usage limit (never swapped for another login or the company account), and a
			-- plan pays for follow-up work only of runs it pays for: never of work another payer started, such as
			-- a listener's run or a login at its limit. New work (no run to follow) may start on it.
			coalesce(public.qorpera_connection_is_chatgpt_plan(connection.id)
				and connection.id = public.qorpera_sponsor_binding_connection(p_prefer_binding_id), false) as kept_plan,
			public.qorpera_connection_is_chatgpt_plan(connection.id) and p_prefer_binding_id is not null
				and connection.id is distinct from public.qorpera_sponsor_binding_connection(p_prefer_binding_id) as plan_blocked
$r0$,
	$a1$		select own.binding_id, own.version, 1 as rank, own.preferred, own.remaining, own.created_at
		from own where own.remaining <> 0
$a1$,
	$r1$		select own.binding_id, own.version, 1 as rank, (own.preferred or own.kept_plan) as preferred, own.remaining, own.created_at
		from own where (own.remaining <> 0 or own.kept_plan) and not own.plan_blocked
$r1$,
	$a2$		from own where own.remaining = 0
$a2$,
	$r2$		from own where own.remaining = 0 and not own.kept_plan and not own.plan_blocked
$r2$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure, array[
	$a0$    v_handed_off uuid;
$a0$,
	$r0$    v_handed_off uuid; v_saved_at_limit boolean;
$r0$,
	$a1$    select * into v_choice from public.qorpera_eligible_member_accounts(p_profile_id,v_user) candidate
        order by (candidate.connection_id = v_handed_off) desc nulls last,
$a1$,
	$r1$    -- Sign in with ChatGPT (20260929913000): a conversation the member's ChatGPT plan pays for keeps it, also at
    -- its usage limit, which then stops the work there; and a plan never takes over a conversation whose
    -- login reached its limit.
    if v_saved.connection_id is not null and public.qorpera_connection_is_chatgpt_plan(v_saved.connection_id)
        and public.qorpera_member_plan_connection_usable(p_profile_id, v_user, v_saved.connection_id) then
        return v_saved.connection_id;
    end if;
    v_saved_at_limit := v_saved.connection_id is not null
        and public.qorpera_connection_at_limit(v_saved.connection_id);
    select * into v_choice from public.qorpera_eligible_member_accounts(p_profile_id,v_user) candidate
        where not (coalesce(v_saved_at_limit, false)
            and public.qorpera_connection_is_chatgpt_plan(candidate.connection_id))
        order by (candidate.connection_id = v_handed_off) desc nulls last,
$r1$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_resolve_failed_execution_run(uuid,text)'::regprocedure, array[
	$a0$		or (p_action = 'retry' and v_run.source_kind <> 'session_turn')
$a0$,
	$r0$		or (p_action = 'retry' and v_run.source_kind <> 'session_turn')
		-- Only the member whose ChatGPT plan pays for a run tries it again (Sign in with ChatGPT, 20260929913000).
		or (p_action = 'retry' and auth.uid() is distinct from v_run.requested_by_user_id
			and public.qorpera_sponsor_version_is_chatgpt_plan(v_run.sponsor_binding_id, v_run.sponsor_version))
$r0$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_retry_company_proposal_review(uuid)'::regprocedure, array[
	$a0$	from public.qorpera_starter_sponsor(v_review.profile_id, v_proposal.created_by_user_id,
		v_review.reviewer_staff_agent_id, null) as payer;
$a0$,
	$r0$	from public.qorpera_starter_sponsor(v_review.profile_id, v_proposal.created_by_user_id,
		-- A retry follows the review's own payer (20260929913000): a review the author's ChatGPT plan paid for stays
		-- on it, and a plan never takes over a review another login paid for.
		v_review.reviewer_staff_agent_id, v_review.reviewer_sponsor_binding_id) as payer;
$r0$,
	$a1$	if v_authority.staff_agent_id is null or not exists (
$a1$,
	$r1$	-- Only the member who started the change retries its review on their own ChatGPT plan (Sign in with
	-- ChatGPT, 20260929913000).
	if auth.uid() is distinct from v_proposal.created_by_user_id
		and public.qorpera_sponsor_version_is_chatgpt_plan(v_authority.sponsor_binding_id, v_authority.sponsor_version) then
		raise exception 'only the member whose ChatGPT plan pays may retry this review' using errcode = '42501'; end if;
	if v_authority.staff_agent_id is null or not exists (
$r1$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_begin_chatgpt_plan_sign_in(uuid,uuid,uuid,uuid,text,integer)'::regprocedure, array[
	$a0$	if not public.qorpera_chatgpt_plan_allowed(p_profile_id) then
		raise exception 'ChatGPT plan sign-in is switched off' using errcode = '55000';
$a0$,
	$r0$	if not public.qorpera_chatgpt_plan_allowed(p_profile_id) then
		raise exception 'ChatGPT plan sign-in is switched off' using errcode = '55000';
	end if;
	-- One ChatGPT plan per member in a company (20260929913000): a second account is never connected beside a
	-- usable one, so plans are never pooled or rotated. Signing in again after a plan login lapsed stays possible.
	if public.qorpera_member_other_plan_connection(p_profile_id, v_user_id, p_client_connection_id) then
		raise exception 'Disconnect your other ChatGPT plan first' using errcode = '55000';
$r0$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_complete_model_login_sign_in_kind(uuid,text,uuid,text,uuid,text,text,text,timestamp with time zone,timestamp with time zone,text,text,text,timestamp with time zone)'::regprocedure, array[
	$a0$		raise exception 'provider connection identity is already bound' using errcode = '23505';
	end if;
$a0$,
	$r0$		raise exception 'provider connection identity is already bound' using errcode = '23505';
	end if;
	-- One ChatGPT plan per member in a company (20260929913000): checked again here, where it counts.
	if p_login_kind = 'chatgpt_plan' then
		-- One completion per member and company at a time, so two cannot both find no other plan.
		perform pg_advisory_xact_lock(hashtextextended('qorpera-chatgpt-plan:' || v_session.profile_id::text
			|| ':' || v_identity.owner_user_id::text, 0));
	end if;
	if p_login_kind = 'chatgpt_plan'
		and public.qorpera_member_other_plan_connection(v_session.profile_id, v_identity.owner_user_id,
			v_connection.client_connection_id) then
		raise exception 'Disconnect your other ChatGPT plan first' using errcode = '55000';
	end if;
$r0$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_coding_owner_sponsor(uuid,uuid,text)'::regprocedure, array[
	$a0$	order by connection.created_at desc limit 1;
$a0$,
	$r0$	-- A login other than a ChatGPT plan first (20260929913000): a plan pays for coding only of work started on it.
	order by public.qorpera_connection_is_chatgpt_plan(connection.id), connection.created_at desc limit 1;
$r0$,
	$a1$		v_client := encode(extensions.digest(convert_to('qorpera-coding-owner:' || v_connection.id::text || ':' || v_version.version::text, 'utf8'), 'sha256'), 'hex')::text;
		v_client := (left(v_client, 8) || '-' || substr(v_client, 9, 4) || '-4' || substr(v_client, 14, 3) || '-8' || substr(v_client, 18, 3) || '-' || substr(v_client, 21, 12))::uuid;
$a1$,
	$r1$		-- The digest's hex never fit the uuid variable, so this path failed (22P02) since 20260922230000 (20260929913000).
		select (left(digest.hex, 8) || '-' || substr(digest.hex, 9, 4) || '-4' || substr(digest.hex, 14, 3) || '-8'
			|| substr(digest.hex, 18, 3) || '-' || substr(digest.hex, 21, 12))::uuid into v_client
		from (select encode(extensions.digest(convert_to('qorpera-coding-owner:' || v_connection.id::text || ':'
			|| v_version.version::text, 'utf8'), 'sha256'), 'hex') as hex) as digest;
$r1$]);

select pg_temp.qorpera_plan_rules_20260929913000_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)'::regprocedure, array[
	$a0$			from public.qorpera_coding_owner_sponsor(v_run.profile_id, v_owner, p_request ->> 'harness') sponsor;
$a0$,
	$r0$			from public.qorpera_coding_owner_sponsor(v_run.profile_id, v_owner, p_request ->> 'harness') sponsor;
			-- A member's ChatGPT plan pays for coding only when the asking run is paid by that plan (20260929913000).
			if public.qorpera_sponsor_version_is_chatgpt_plan(v_sponsor_binding, v_sponsor_version)
				and public.qorpera_sponsor_binding_connection(v_sponsor_binding)
					is distinct from public.qorpera_sponsor_binding_connection(v_run.sponsor_binding_id) then
				raise exception 'Coding for this work needs a Codex login: a ChatGPT plan pays only for work started on it'
					using errcode = '55000'; end if;
$r0$]);
