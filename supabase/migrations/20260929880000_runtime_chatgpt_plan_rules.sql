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
--    when the routine is saved, and again when it wakes (a routine's login can move later).
-- 3. It is never swapped at its usage limit: a conversation it pays for keeps it, and follow-up work
--    keeps it. A run in progress is never handed to another login since 20260929840000 (#601), which this
--    migration needs before plans switch on; the handoff function itself stays as it is (test 658 pins it).
-- 4. Only the member whose plan pays retries a failed run on it, or a change's review.
-- 5. Plan use stops for a company being deleted (qorpera_chatgpt_plan_allowed).
-- Codex logins are unchanged by this migration.
--
-- Each function is patched by exact text, once (the marker 20260929880000 skips a replay); a source that differs
-- stops the migration. Locks: none added; the helpers read a login's kind by its capsule (unique index).

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

-- Plan use stops for a company being deleted.
create or replace function public.qorpera_chatgpt_plan_allowed(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
	select coalesce((select settings.enabled from public.qorpera_chatgpt_plan_settings as settings), false)
		and exists (select 1 from public.qorpera_chatgpt_plan_companies as company where company.profile_id = p_profile_id)
		and public.qorpera_model_login_sign_in_url(p_profile_id) is not null
		-- Sign in with ChatGPT, 20260929880000: not while the company is being deleted.
		and not public.qorpera_company_deleting(p_profile_id)
$$;

create function pg_temp.qorpera_plan_rules_20260929880000_patch(p_target regprocedure, p_pairs text[])
returns void language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_target); v_count integer;
begin
	if position('20260929880000' in v_definition) > 0 then return; end if;
	for v_index in 1 .. array_length(p_pairs, 1) / 2 loop
		v_count := (length(v_definition) - length(replace(v_definition, p_pairs[2 * v_index - 1], '')))
			/ length(p_pairs[2 * v_index - 1]);
		if v_count <> 1 then
			raise exception '% source differs (anchor % matches % times)', p_target, v_index, v_count; end if;
		v_definition := replace(v_definition, p_pairs[2 * v_index - 1], p_pairs[2 * v_index]);
	end loop;
	if position('20260929880000' in v_definition) = 0 then raise exception '% patch has no marker', p_target; end if;
	execute v_definition;
end
$patch$;

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_ensure_unattended_sponsor(public.qorpera_execution_runs)'::regprocedure, array[
	$a0$		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
$a0$,
	$r0$		and not exists (select 1 from public.qorpera_provider_connection_versions harness
			where harness.connection_id = connection.id and harness.native_harness = 'claude-code')
		-- A member's ChatGPT plan works while they are away only once they turned that on themselves: it is
		-- never consented for them here (Sign in with ChatGPT, 20260929880000).
		and not public.qorpera_connection_plan_awaits_consent(connection.id)
$r0$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_activate_company_file_listener()'::regprocedure, array[
	$a0$	if jsonb_array_length(new.triggers) <> 1 then
		raise exception 'A listener cannot also be a schedule' using errcode = '22023'; end if;
$a0$,
	$r0$	if jsonb_array_length(new.triggers) <> 1 then
		raise exception 'A listener cannot also be a schedule' using errcode = '22023'; end if;
	-- A ChatGPT plan pays only for work its member starts: never for a file change or an event anyone may
	-- cause (Sign in with ChatGPT, 20260929880000).
	if public.qorpera_sponsor_version_is_chatgpt_plan(new.sponsor_binding_id, new.sponsor_version) then
		raise exception 'A ChatGPT plan cannot pay for a listener' using errcode = '42501'; end if;
$r0$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_wake_authorized(public.qorpera_wake_occurrences)'::regprocedure, array[
	$a0$	if public.qorpera_environment_is_folder_v2(p_wake.environment_id) then return public.qorpera_folder_wake_authorized(p_wake); end if;
$a0$,
	$r0$	if public.qorpera_environment_is_folder_v2(p_wake.environment_id) then return public.qorpera_folder_wake_authorized(p_wake); end if;
	-- A ChatGPT plan never pays for a file change or an event anyone may cause, also after a routine's login
	-- moved to a plan login (Sign in with ChatGPT, 20260929880000; a folder company takes neither wake at all).
	if p_wake.source_kind in ('company-file', 'event')
		and public.qorpera_sponsor_version_is_chatgpt_plan(p_wake.sponsor_binding_id, p_wake.sponsor_version) then
		return false; end if;
$r0$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_starter_sponsor(uuid,uuid,uuid,uuid)'::regprocedure, array[
	$a0$			public.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at
$a0$,
	$r0$			public.qorpera_native_account_remaining(connection.id, version.version) as remaining, sponsor.created_at,
			-- The run's own ChatGPT plan stays its payer at its usage limit: never swapped for another login or
			-- the company account (Sign in with ChatGPT, 20260929880000).
			coalesce(binding.id = p_prefer_binding_id, false) and public.qorpera_connection_is_chatgpt_plan(connection.id)
				as kept_plan
$r0$,
	$a1$		from own where own.remaining <> 0
$a1$,
	$r1$		from own where own.remaining <> 0 or own.kept_plan
$r1$,
	$a2$		from own where own.remaining = 0
$a2$,
	$r2$		from own where own.remaining = 0 and not own.kept_plan
$r2$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_eligible_member_accounts(uuid,uuid)'::regprocedure, array[
	$a0$        and public.qorpera_native_account_remaining(connection.id,version.version) <> 0
$a0$,
	$r0$        and (public.qorpera_native_account_remaining(connection.id,version.version) <> 0
            -- A ChatGPT plan at its usage limit stays the account of the conversations it pays for: the
            -- limit stops the work there, never moves it (Sign in with ChatGPT, 20260929880000).
            or public.qorpera_connection_is_chatgpt_plan(connection.id))
$r0$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure, array[
	$a0$            candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1;
$a0$,
	$r0$            -- A ChatGPT plan at its usage limit keeps its conversations; a new one starts on a login with
            -- room first (Sign in with ChatGPT, 20260929880000).
            (candidate.remaining = 0),candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1;
$r0$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_member_first_run_sponsor(uuid,uuid)'::regprocedure, array[
	$a0$    order by candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1
$a0$,
	$r0$    -- A ChatGPT plan at its usage limit is eligible but not picked anew while another login has room
    -- (Sign in with ChatGPT, 20260929880000).
    order by (candidate.remaining = 0),candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1
$r0$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_resolve_failed_execution_run(uuid,text)'::regprocedure, array[
	$a0$		or (p_action = 'retry' and v_run.source_kind <> 'session_turn')
$a0$,
	$r0$		or (p_action = 'retry' and v_run.source_kind <> 'session_turn')
		-- Only the member whose ChatGPT plan pays for a run tries it again (Sign in with ChatGPT, 20260929880000).
		or (p_action = 'retry' and auth.uid() is distinct from v_run.requested_by_user_id
			and public.qorpera_sponsor_version_is_chatgpt_plan(v_run.sponsor_binding_id, v_run.sponsor_version))
$r0$]);

select pg_temp.qorpera_plan_rules_20260929880000_patch('public.qorpera_retry_company_proposal_review(uuid)'::regprocedure, array[
	$a0$	if v_authority.staff_agent_id is null or not exists (
$a0$,
	$r0$	-- Only the member who started the change retries its review on their own ChatGPT plan (Sign in with
	-- ChatGPT, 20260929880000).
	if auth.uid() is distinct from v_proposal.created_by_user_id
		and public.qorpera_sponsor_version_is_chatgpt_plan(v_authority.sponsor_binding_id, v_authority.sponsor_version) then
		raise exception 'only the member whose ChatGPT plan pays may retry this review' using errcode = '42501'; end if;
	if v_authority.staff_agent_id is null or not exists (
$r0$]);
