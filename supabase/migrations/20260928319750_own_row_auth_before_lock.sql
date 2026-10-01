-- Authorization before the row lock. Eight functions locked the row their argument names FOR UPDATE and only then
-- checked that the caller may act on it, on three kinds of row: an artifact cleanup plan (cancelling and retrying
-- it), a company proposal (accepting, rejecting and rebasing it) and a shared session (configuring its execution, and
-- asking for a turn through qorpera_request_session_turn_v2 or the qorpera_request_session_turn behind it). Anyone
-- signed in who knew or guessed such an id could queue for that row, take it ahead of the company's own writers, and
-- by repeating the call make them wait. For the cleanup plan and the session row the publishable key was enough:
-- anon can call both cleanup plan functions, the configuration and qorpera_request_session_turn through the platform
-- default.
--
-- Each now reads the row's company without a lock and refuses before the lock a caller the locked check would
-- refuse, with the same error, so a refusal tells no more than before: an id nobody has gets it too. A caller who
-- passes takes the lock as before, and everything after it is unchanged: the locked check still refuses a member
-- who lost the role while the call waited. The checks before the lock in the rebase and the turn requests (a
-- folder-v2 company, a paused company) keep their place, first.
--
-- Exact-text patches: each fails unless its function locks its row once, with the text given.

create function pg_temp.own_row_auth_first_patch(p_function regprocedure, p_lock text, p_check text) returns void
language plpgsql as $patch$
declare v_definition text := pg_get_functiondef(p_function);
begin
	if (length(v_definition) - length(replace(v_definition, p_lock, ''))) / length(p_lock) <> 1 then
		raise exception '% does not lock its row where this migration expects', p_function; end if;
	execute replace(v_definition, p_lock, p_check || p_lock);
end
$patch$;

-- Cancelling and retrying an artifact cleanup plan: the company's owners and admins.
select pg_temp.own_row_auth_first_patch(plan_function,
	$lock$	select plan.* into v_plan
	from public.qorpera_artifact_gc_plans as plan where plan.id = p_plan_id for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_authorize_profile(
		(select plan.profile_id from public.qorpera_artifact_gc_plans as plan where plan.id = p_plan_id)) then
		raise exception 'artifact cleanup requires full access' using errcode = '42501';
	end if;
$check$)
from unnest(array['public.qorpera_cancel_artifact_gc_plan(uuid)', 'public.qorpera_retry_artifact_gc_plan(uuid)']::regprocedure[])
	as plan_function;

-- Accepting, rejecting and rebasing a company proposal: the company's owners and admins.
select pg_temp.own_row_auth_first_patch(proposal_function,
	$lock$	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id
	for update;$lock$,
	$check$	if not public.qorpera_can_authorize_profile(
		(select proposal.profile_id from public.qorpera_company_proposals as proposal where proposal.id = p_proposal_id)) then
		raise exception 'company proposal authorization is required' using errcode = '42501';
	end if;
$check$)
from unnest(array['public.qorpera_accept_company_proposal(uuid,uuid)', 'public.qorpera_reject_company_proposal(uuid,uuid)']::regprocedure[])
	as proposal_function;
select pg_temp.own_row_auth_first_patch('public.qorpera_rebase_company_proposal(uuid,uuid,uuid,uuid)',
	$lock$	select proposal.* into v_proposal
	from public.qorpera_company_proposals as proposal
	where proposal.id = p_proposal_id for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_authorize_profile(
		(select proposal.profile_id from public.qorpera_company_proposals as proposal where proposal.id = p_proposal_id)) then
		raise exception 'company proposal rebase authorization is required' using errcode = '42501';
	end if;
$check$);

-- Configuring a shared session's execution: the company's owners and admins.
select pg_temp.own_row_auth_first_patch('public.qorpera_configure_session_execution(uuid,uuid,bigint,uuid,text,text,text,text,uuid[])',
	$lock$	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = p_session_id for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_authorize_profile(
		(select session.profile_id from public.qorpera_shared_sessions as session where session.id = p_session_id)) then
		raise exception 'session execution configuration requires authorize access' using errcode = '42501';
	end if;
$check$);

-- Asking for a turn in a shared session: the company's owners, admins and contributors. qorpera_request_session_turn_v2
-- checks and locks, then calls qorpera_request_session_turn, which does both again before the request and refuses
-- with 22023 for any failed check, as before.
select pg_temp.own_row_auth_first_patch('public.qorpera_request_session_turn_v2(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
	$lock$	select session.* into v_session
	from public.qorpera_shared_sessions as session
	where session.id = p_session_id
	for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_write_profile(
		(select session.profile_id from public.qorpera_shared_sessions as session where session.id = p_session_id)) then
		raise exception 'session turn request is unavailable' using errcode = '42501';
	end if;
$check$);
select pg_temp.own_row_auth_first_patch('public.qorpera_request_session_turn(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid,text,text,text,text,text,uuid[])',
	$lock$	select session.* into v_session
	from public.qorpera_shared_sessions as session where session.id = p_session_id for update;$lock$,
	$check$	if v_user_id is null or not public.qorpera_can_write_profile(
		(select session.profile_id from public.qorpera_shared_sessions as session where session.id = p_session_id)) then
		raise exception 'session turn request is invalid' using errcode = '22023';
	end if;
$check$);

drop function pg_temp.own_row_auth_first_patch(regprocedure, text, text);
