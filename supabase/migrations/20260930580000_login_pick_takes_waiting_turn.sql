-- 20260930580000: the member's own pick of a login takes their turn waiting at another login's usage limit (5 Nov 2026).
-- Live on 5 Nov, right after 20260930579000: the founder started a company whose only login was at its weekly limit, so
-- the Co-Founder's first run was queued on it to wait for the reset (7 Nov). The founder then connected a second login
-- with room to begin now. Nothing moved, as the 4 October rule says (20260930059000): work stays on its login until the
-- member picks another by hand. But there was nothing to pick: opening the Co-Founder's thread had saved the new login as
-- the conversation's (qorpera_select_member_session_account), so the thread showed no limit and no "Use …" button, while
-- the first run went on waiting on the old login, unseen.
-- * A conversation's login is the one the member's own turn waits on there, while it waits at that login's usage limit:
--   the thread says so and offers the member's other logins ("Or use another of your logins now").
-- * The member's pick of a login there (qorpera_choose_member_session_account) also takes their own turns waiting at
--   another login's limit in that conversation, when the picked login has room: they go on, on it. That is the member's
--   own permission to pay with it. A wake (a post in a thread, a routine's run) never changes payer (575000), and nothing
--   moves without the pick.
-- Locks: the pick takes the waiting requests FOR UPDATE SKIP LOCKED after the conversation's row, as before; one the
-- materializer holds stays as it is. Every new or changed body carries the marker 20260930580000.

set local lock_timeout = '3s';

create function pg_temp.lp580_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930580000' in v_definition) > 0 then
		raise exception '20260930580000 is already in %', p_target; end if;
	if p_old = '' or (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930580000 anchor differs in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

-- The member's own turns in a conversation that wait at their login's usage limit: queued, not begun, paid by one of
-- their logins, oldest first.
create function public.qorpera_member_session_waiting_turns(p_profile_id uuid, p_session_id uuid, p_user_id uuid)
returns table(request_id uuid, sponsor_binding_id uuid)
language sql stable security definer set search_path = '' as $$
	-- 20260930580000
	select request.id, request.sponsor_binding_id
	from public.qorpera_session_turn_requests as request
	join public.qorpera_session_inputs as input on input.id = request.input_id and input.session_id = request.session_id
	where request.profile_id = p_profile_id and request.session_id = p_session_id and request.status = 'queued'
		and request.sponsor_mode = 'member_connection' and request.sponsored_by_user_id = p_user_id
		and input.completed_at is null and input.failed_at is null and input.execution_run_id is null and input.turn_id is null
		and public.qorpera_sponsor_waits_for_usage_limit(request.sponsor_binding_id, request.sponsor_version)
	order by request.created_at, request.id
$$;
revoke all on function public.qorpera_member_session_waiting_turns(uuid, uuid, uuid)
	from public, anon, authenticated, service_role;

-- The conversation's login: the one the member's turn waits on there, first.
select pg_temp.lp580_patch('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure,
	$old$select * into v_saved from public.qorpera_member_session_accounts$old$,
	$new$-- 20260930580000: the login the member's own turn here waits on, at its usage limit, is the conversation's: the
    -- thread says so and offers their other logins by hand.
    select candidate.* into v_choice
        from public.qorpera_member_session_waiting_turns(p_profile_id,p_session_id,v_user) as waiting
        join public.qorpera_member_live_accounts(p_profile_id,v_user) as candidate
            on candidate.binding_id = waiting.sponsor_binding_id
        limit 1;
    if found then
        insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
            values(p_profile_id,p_session_id,v_user,v_choice.connection_id,v_choice.binding_id)
            on conflict(profile_id,session_id,user_id) do update set
                connection_id = excluded.connection_id,sponsor_binding_id = excluded.sponsor_binding_id,
                selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
                    then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
        return v_choice.connection_id;
    end if;
    select * into v_saved from public.qorpera_member_session_accounts$new$);

-- The member's pick takes their waiting turns here, when the picked login has room.
select pg_temp.lp580_patch('public.qorpera_choose_member_session_account(uuid,uuid,uuid)'::regprocedure,
	$old$return v_choice.connection_id;$old$,
	$new$-- 20260930580000: the member's own pick is their permission to pay with it for their turns waiting here at
    -- another login's usage limit: they go on, on it. One the materializer holds is skipped.
    if not public.qorpera_sponsor_waits_for_usage_limit(v_choice.binding_id, v_choice.sponsor_version) then
        update public.qorpera_session_turn_requests as request
            set sponsor_binding_id = v_choice.binding_id, sponsor_version = v_choice.sponsor_version
            where request.id in (select waiting.request_id
                    from public.qorpera_member_session_waiting_turns(p_profile_id,p_session_id,v_user) as waiting
                    where waiting.sponsor_binding_id <> v_choice.binding_id)
                and request.compute_identity_id = v_choice.compute_identity_id
                and request.id in (select locked.id from public.qorpera_session_turn_requests as locked
                    where locked.session_id = p_session_id and locked.status = 'queued' for update skip locked);
    end if;
    return v_choice.connection_id;$new$);

-- A waiting turn that changed login is work for the materializer now.
create trigger qorpera_session_turn_requests_sponsor_wake_orchestrators
	after update of sponsor_binding_id on public.qorpera_session_turn_requests
	for each row when (new.status = 'queued' and new.sponsor_binding_id is distinct from old.sponsor_binding_id)
	execute function public.qorpera_wake_runner_orchestrators_internal();

drop function pg_temp.lp580_patch(regprocedure, text, text);
