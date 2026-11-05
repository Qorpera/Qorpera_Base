-- 20260930579000: a used-up login is still connected, and a company started on it waits for the reset (founder, 5 Nov 2026).
-- Live on 5 Nov: the founder's only ChatGPT login, an account login used in all their companies, was at its weekly
-- limit, and a new company's founding table said "ChatGPT not connected" and kept Start shut: the table counted only
-- logins with room (qorpera_eligible_member_accounts). Asked, the founder said "Yes, fix it": the table says the login
-- is used up and when it resets, Start works, and the Co-Founder's first run waits and goes on by itself at the reset, as
-- every other work at a usage limit does since 20260930575000.
-- * Connected, Ready and Start ask for a live login of the founder's own (qorpera_member_live_accounts: at any usage),
--   not one with room. A seat says whether its founder's logins are all used up (modelLoginUsedUp) and when the first of
--   them resets (modelLoginResetsAt, null when no reset is known).
-- * The first run's payer (qorpera_member_first_run_sponsor, for the founding Start, the creation's kickoff, the
--   follow-up queue and Start agent first run) is, as before, the founder's login with the most room; with none, now
--   the founder's own login at its limit that resets first. Its turn request is queued on that login and the
--   materializer leaves it queued until the login has room (20260930575000). Nothing moves to another login.
-- * A started table says when its Co-Founder's waiting first run goes on (start.firstRunWaitsUntil).
-- Older web clients read the table as before: they ignore the new keys, and modelLoginReady now means connected.
-- Locks: none new; the changed bodies only read. Every new or changed body carries the marker 20260930579000.

create function pg_temp.fl579_patch(p_target regprocedure, p_old text, p_new text, p_again boolean default false)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930579000' in v_definition) > 0 <> p_again then
		raise exception '20260930579000 is % in %', case when p_again then 'not yet' else 'already' end, p_target; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930579000 anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- When a login at its usage limit resets: its wall's end, else the reset its newest full usage reading names.
create function public.qorpera_native_account_resets_at(p_connection_id uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
	-- 20260930579000
	select coalesce(public.qorpera_native_account_usage_limit_reset(p_connection_id),
		public.qorpera_native_account_wall_reading_reset(p_connection_id))
$$;

-- Whether every live login of a member in a company is used up (they have some, and none with room), and when the first
-- of them resets.
create function public.qorpera_member_logins_used_up(p_profile_id uuid, p_user_id uuid,
	out used_up boolean, out resets_at timestamptz)
language sql stable security definer set search_path = '' as $$
	-- 20260930579000
	select exists (select 1 from public.qorpera_member_live_accounts(p_profile_id, p_user_id))
			and not exists (select 1 from public.qorpera_eligible_member_accounts(p_profile_id, p_user_id)),
		case when not exists (select 1 from public.qorpera_eligible_member_accounts(p_profile_id, p_user_id)) then
			(select min(public.qorpera_native_account_resets_at(live.connection_id))
				from public.qorpera_member_live_accounts(p_profile_id, p_user_id) as live where live.remaining = 0) end
$$;

-- When the Co-Founder's first run, queued on a login at its usage limit, goes on; null when it does not wait.
create function public.qorpera_folder_company_first_run_waits_until(p_profile_id uuid)
returns timestamptz
language sql stable security definer set search_path = '' as $$
	-- 20260930579000: the head of the first run's requests, as qorpera_folder_company_first_run_state reads it.
	select case when request.status = 'queued'
			and public.qorpera_sponsor_waits_for_usage_limit(request.sponsor_binding_id, request.sponsor_version)
		then (select public.qorpera_native_account_resets_at(sponsor.provider_connection_id)
			from public.qorpera_execution_sponsor_versions as sponsor
			where sponsor.binding_id = request.sponsor_binding_id and sponsor.version = request.sponsor_version) end
	from public.qorpera_folder_company_creations as creation
	join public.qorpera_agent_first_runs as first_run on first_run.profile_id = creation.profile_id
		and first_run.staff_agent_id = creation.cofounder_id
	join public.qorpera_session_inputs as input on input.id = first_run.input_id
		and input.completed_at is null and input.execution_run_id is null and input.failed_at is null
	join public.qorpera_session_turn_requests as request on request.input_id = input.id
		and not exists (select 1 from public.qorpera_session_turn_requests as retry where retry.retry_of_request_id = request.id)
	where creation.profile_id = p_profile_id
$$;

revoke all on function public.qorpera_native_account_resets_at(uuid),
	public.qorpera_member_logins_used_up(uuid, uuid),
	public.qorpera_folder_company_first_run_waits_until(uuid)
	from public, anon, authenticated, service_role;

-- The first run's payer: the member's login with the most room, else their own login at its limit that resets first.
do $$
begin
	if position('order by candidate.remaining desc,candidate.connection_id,candidate.binding_id limit 1'
		in pg_get_functiondef('public.qorpera_member_first_run_sponsor(uuid,uuid)'::regprocedure)) = 0 then
		raise exception 'qorpera_member_first_run_sponsor changed; rebase 20260930579000 on it'; end if;
end $$;
create or replace function public.qorpera_member_first_run_sponsor(p_profile_id uuid, p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
    -- 20260930579000: with no login with room, the member's own login at its limit: the run waits there for the reset.
    select jsonb_build_object('sponsorBindingId',candidate.binding_id,'sponsorVersion',candidate.sponsor_version,
        'computeIdentityId',candidate.compute_identity_id)
    from (select eligible.*, false as used_up, null::timestamptz as resets_at
            from public.qorpera_eligible_member_accounts(p_profile_id,p_user_id) as eligible
        union all
        select live.*, true, public.qorpera_native_account_resets_at(live.connection_id)
            from public.qorpera_member_live_accounts(p_profile_id,p_user_id) as live
            where live.remaining = 0) as candidate
    order by candidate.used_up,candidate.remaining desc,candidate.resets_at nulls last,candidate.connection_id,
        candidate.binding_id limit 1
$$;

-- The table: connected means a live login of one's own; a used-up one says so, with its reset.
select pg_temp.fl579_patch('public.qorpera_company_founding_json(uuid)'::regprocedure,
	$old$public.qorpera_eligible_member_accounts(p_profile_id,seat.user_id)),$old$,
	$new$public.qorpera_member_live_accounts(p_profile_id,seat.user_id)),
		-- 20260930579000: all their logins used up, and when the first resets.
		'modelLoginUsedUp',seat.state = 'joined' and coalesce((select used.used_up
			from public.qorpera_member_logins_used_up(p_profile_id,seat.user_id) as used),false),
		'modelLoginResetsAt',case when seat.state = 'joined' then (select used.resets_at
			from public.qorpera_member_logins_used_up(p_profile_id,seat.user_id) as used) end,$new$);
select pg_temp.fl579_patch('public.qorpera_company_founding_json(uuid)'::regprocedure,
	$old$'firstRun',public.qorpera_folder_company_first_run_state(p_profile_id)) end);$old$,
	$new$'firstRun',public.qorpera_folder_company_first_run_state(p_profile_id),
			-- 20260930579000: when a first run waiting on a used-up login goes on.
			'firstRunWaitsUntil',public.qorpera_folder_company_first_run_waits_until(p_profile_id)) end);$new$, true);
-- Ready and Start: a live login of one's own, at any usage.
select pg_temp.fl579_patch('public.qorpera_set_founder_ready(uuid,bigint,boolean)'::regprocedure,
	$old$public.qorpera_eligible_member_accounts(p_profile_id,auth.uid())$old$,
	$new$/* 20260930579000 */ public.qorpera_member_live_accounts(p_profile_id,auth.uid())$new$);
select pg_temp.fl579_patch('public.qorpera_start_company_founding(uuid,bigint,uuid)'::regprocedure,
	$old$public.qorpera_eligible_member_accounts(p_profile_id,seat.user_id)$old$,
	$new$/* 20260930579000 */ public.qorpera_member_live_accounts(p_profile_id,seat.user_id)$new$);

drop function pg_temp.fl579_patch(regprocedure, text, text, boolean);
