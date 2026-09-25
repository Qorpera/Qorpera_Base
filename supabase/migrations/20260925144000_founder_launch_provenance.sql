-- A shared founding kickoff retains its original creation author. The member
-- who presses Start supplies their own model account and requests the run.
-- Only that exact, receipted kickoff may differ from the ordinary author rule.
create function public.qorpera_founding_kickoff_requested_by(
    p_profile_id uuid,p_input_id uuid,p_turn_request_id uuid,p_requested_by_user_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
    select exists(
        select 1 from public.qorpera_company_founding founding
        join public.qorpera_company_first_runs first_run on first_run.profile_id = founding.profile_id
        join public.qorpera_session_inputs input on input.id = first_run.input_id and input.kind = 'kickoff'
        join public.qorpera_shared_sessions session on session.id = input.session_id and session.profile_id = founding.profile_id
        join public.qorpera_session_turn_requests request on request.id = p_turn_request_id
            and request.profile_id = founding.profile_id and request.input_id = input.id and request.session_id = input.session_id
        where founding.profile_id = p_profile_id and founding.phase = 'launched' and input.id = p_input_id
            and request.requested_by_user_id = p_requested_by_user_id
            and request.sponsored_by_user_id = p_requested_by_user_id and request.sponsor_mode = 'member_connection'
            and founding.launch_receipt ->> 'kickoffInputId' = input.id::text
            and founding.launch_receipt ->> 'turnRequestId' = request.id::text
            and founding.launch_receipt ->> 'launchedByUserId' = p_requested_by_user_id::text
    )
$$;
revoke all on function public.qorpera_founding_kickoff_requested_by(uuid,uuid,uuid,uuid)
    from public,anon,authenticated,service_role;

create function pg_temp.founding_replace(p_definition text,p_old text,p_new text)
returns text language plpgsql as $$
begin
    if (length(p_definition)-length(replace(p_definition,p_old,'')))/length(p_old) <> 1 then
        raise exception 'Founding input provenance anchor differs: %',left(p_old,100); end if;
    return replace(p_definition,p_old,p_new);
end $$;

-- The older desktop arbiter writes session_turns directly. Hold its claim
-- before it can consume the shared kickoff, using the same launch row lock.
do $$ declare v text; begin
    v := pg_get_functiondef('public.qorpera_claim_session_turn(uuid,uuid,integer,uuid,bigint)'::regprocedure);
    v := pg_temp.founding_replace(v,
        'perform public.qorpera_session_profile_for_write(p_session_id);',
        'perform public.qorpera_session_profile_for_write(p_session_id);
    perform 1 from public.qorpera_company_founding
        where profile_id = (select profile_id from public.qorpera_shared_sessions where id = p_session_id)
            and phase <> ''launched'' for share;
    if found then
        raise exception ''Company founding has not launched'' using errcode = ''55000''; end if;');
    execute v;
end $$;

-- A joined founder can take the setup responsibility before the launch grants
-- company ownership. Membership alone never permits claiming this role.
do $$ declare v text; begin
    v := pg_get_functiondef('public.qorpera_accept_computer_usage_ownership(uuid,uuid)'::regprocedure);
    v := pg_temp.founding_replace(v,
        'where profile_id = p_profile_id and user_id = auth.uid() and role = ''owner'') then',
        'where profile_id = p_profile_id and user_id = auth.uid() and (role = ''owner'' or
            (role in (''admin'',''contributor'') and exists(select 1 from public.qorpera_company_founder_seats seat
                join public.qorpera_company_founding founding on founding.profile_id = seat.profile_id
                where seat.profile_id = p_profile_id and seat.user_id = auth.uid()
                    and seat.state = ''joined'' and founding.phase = ''open'')))) then');
    execute v;
end $$;

create or replace function public.qorpera_guard_founder_departure()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile public.qorpera_profiles%rowtype;
begin
    if tg_op = 'UPDATE' and new.role = old.role then return new; end if;
    select * into v_profile from public.qorpera_profiles where id = old.profile_id for update;
    if not found then return coalesce(new,old); end if;
    if v_profile.computer_usage_owner_user_id = old.user_id and (tg_op = 'DELETE' or new.role = 'viewer'
        or (old.role = 'owner' and new.role <> 'owner')) then
        raise exception 'Reassign Computer Usage owner before leaving' using errcode = '42501'; end if;
    if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner') then
        if not exists(select 1 from public.qorpera_profile_members where profile_id = old.profile_id
            and user_id <> old.user_id and role = 'owner') then
            raise exception 'The last company owner cannot leave' using errcode = '42501'; end if;
    end if;
    if tg_op = 'DELETE' and v_profile.created_by_user_id = old.user_id and exists (
        select 1 from public.qorpera_company_bootstrap_jobs where profile_id = old.profile_id and state <> 'completed') then
        raise exception 'Company setup must complete before its creator leaves' using errcode = '42501'; end if;
    return coalesce(new,old);
end
$$;

do $$ declare v text; begin
    v := pg_get_functiondef('public.qorpera_materialize_session_turn_requests(integer)'::regprocedure);
    v := pg_temp.founding_replace(v,
        'if not found or v_input.author_user_id is distinct from v_request.requested_by_user_id then',
        'if not found or (v_input.author_user_id is distinct from v_request.requested_by_user_id and not
            public.qorpera_founding_kickoff_requested_by(v_request.profile_id,v_input.id,v_request.id,v_request.requested_by_user_id)) then');
    execute v;

    v := pg_get_functiondef('public.qorpera_admit_input_wake()'::regprocedure);
    v := pg_temp.founding_replace(v,
        'and author_user_id = v_run.requested_by_user_id and execution_run_id = v_run.id;',
        'and (author_user_id = v_run.requested_by_user_id or
            public.qorpera_founding_kickoff_requested_by(v_run.profile_id,id,v_run.id,v_run.requested_by_user_id))
        and execution_run_id = v_run.id;');
    execute v;

    v := pg_get_functiondef('public.qorpera_pin_wake_occurrence()'::regprocedure);
    v := pg_temp.founding_replace(v,
        'and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id',
        'and session_id = v_run.session_id and (author_user_id = v_run.requested_by_user_id or
            public.qorpera_founding_kickoff_requested_by(v_run.profile_id,id,v_run.id,v_run.requested_by_user_id))');
    execute v;

    v := pg_get_functiondef('public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure);
    v := pg_temp.founding_replace(v,
        'where id = any(v_run.input_ids) and session_id = v_run.session_id and author_user_id = v_run.requested_by_user_id',
        'where id = any(v_run.input_ids) and session_id = v_run.session_id and (author_user_id = v_run.requested_by_user_id or
            public.qorpera_founding_kickoff_requested_by(v_run.profile_id,id,v_run.id,v_run.requested_by_user_id))');
    execute v;

    v := pg_get_functiondef('public.qorpera_company_path_actor(uuid,jsonb)'::regprocedure);
    v := pg_temp.founding_replace(v,
        'or input.author_user_id is distinct from v_run.requested_by_user_id',
        'or (input.author_user_id is distinct from v_run.requested_by_user_id and not
            public.qorpera_founding_kickoff_requested_by(v_run.profile_id,input.id,v_run.id,v_run.requested_by_user_id))');
    execute v;

    v := pg_get_functiondef('public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure);
    v := pg_temp.founding_replace(v,
        'if not found or v_input.author_user_id <> p_run.requested_by_user_id',
        'if not found or (v_input.author_user_id <> p_run.requested_by_user_id and not
            public.qorpera_founding_kickoff_requested_by(p_run.profile_id,v_input.id,p_run.id,p_run.requested_by_user_id))');
    v := pg_temp.founding_replace(v,
        $old$v_text := case when jsonb_typeof(v_input.body -> 'text') = 'string' then v_input.body ->> 'text' else v_input.body::text end;$old$,
        $new$v_text := case when jsonb_typeof(v_input.body -> 'text') = 'string' then v_input.body ->> 'text' else v_input.body::text end;
        if public.qorpera_founding_kickoff_requested_by(p_run.profile_id,v_input.id,p_run.id,p_run.requested_by_user_id) then
            v_text := jsonb_build_object('schema','qorpera.founding-startup/v1','kickoff',v_input.body,
                'founding',(select launch_receipt from public.qorpera_company_founding where profile_id = p_run.profile_id))::text;
        end if;$new$);
    execute v;
end $$;

-- Preserve deployed SECURITY DEFINER owner identities without giving this
-- exception to user/API roles directly.
do $$ declare v_owner name; begin
    for v_owner in select distinct pg_get_userbyid(proowner) from pg_proc where oid = any(array[
        'public.qorpera_materialize_session_turn_requests(integer)'::regprocedure,
        'public.qorpera_admit_input_wake()'::regprocedure,
        'public.qorpera_pin_wake_occurrence()'::regprocedure,
        'public.qorpera_runtime_wake_policy_internal(uuid)'::regprocedure,
        'public.qorpera_company_path_actor(uuid,jsonb)'::regprocedure,
        'public.qorpera_company_context_source(public.qorpera_execution_runs,text,uuid)'::regprocedure
    ]) loop
        if v_owner in ('anon','authenticated','service_role','qorpera_secret_broker') then
            raise exception 'Founding input authority is owned by an API role'; end if;
        execute format('grant execute on function public.qorpera_founding_kickoff_requested_by(uuid,uuid,uuid,uuid) to %I',v_owner);
    end loop;
end $$;
