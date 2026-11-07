-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- Asking which login pays for a conversation works out no room and writes nothing when nothing changes (20260930606000,
-- perf sprint 7 Nov 2026, measure A6). The web asks when a thread opens and every 30 s while one is open; on production
-- each call took 48 to 102 ms, nearly all of it room the function never read, rewrote its saved row and held the
-- conversation's row. Here the base's owner has logins A and B. Each world runs the previous text, undone, and then the new
-- one: same answer, same saved row. A call that changes nothing moves no row, locks none and asks for no room.

set local track_functions = 'all';

-- A conversation this transaction never locked, as a copy of Bob's thread, made without triggers: the fixture's passes hold
-- the rows of the threads they made, a foreign key's check holds the row it names, and an update keeps a lock its own
-- transaction took, so a new lock would not show on those. A call that was undone leaves its xmax, so each check takes a new one.
create function pg_temp.a6_conversation(p_key text) returns void language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_shared_sessions
	select (jsonb_populate_record(null::public.qorpera_shared_sessions,
		to_jsonb(thread) || jsonb_build_object('id', v_id, 'client_session_id', v_id))).*
	from public.qorpera_shared_sessions as thread
	where thread.id = (select room.session_id from public.qorpera_company_rooms as room
		where room.id = pg_temp.base_thread('92400000-0000-4000-8000-000000000031'));
	perform set_config('session_replication_role', 'origin', true);
	perform set_config('qorpera_test.a6_' || p_key, v_id::text, true);
end $$;

-- The owner connects login B, for work while away too, with room left.
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.a6_login',public.qorpera_begin_native_provider_login(
	'92400000-0000-4000-8000-000000000010','11060000-0000-4000-8000-000000000051','11060000-0000-4000-8000-000000000052',
	(current_setting('qorpera_test.base_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('c',64),900)::text,true)
\g /dev/null
reset role;
select pg_temp.base_claims('service_role');
set local role service_role;
select set_config('qorpera_test.a6_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.a6_login')::jsonb ->> 'login_id')::uuid,repeat('c',64),'11060000-0000-4000-8000-000000000060',
	'object://native-capsules/11060000-0000-4000-8000-000000000060',repeat('d',64),'fixture-openai-account-b','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true)
\g /dev/null
reset role;
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.a6_connection')::jsonb ->> 'connection_id')::uuid and version = 1;
select pg_temp.base_claims('authenticated','92400000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.a6_sponsor',public.qorpera_create_member_execution_sponsor(
	'92400000-0000-4000-8000-000000000010','11060000-0000-4000-8000-000000000061',
	(current_setting('qorpera_test.a6_connection')::jsonb ->> 'connection_id')::uuid,2,true)::text,true) \g /dev/null
reset role;
select pg_temp.base_claims('service_role');

create function pg_temp.a6(p_key text) returns uuid language sql as $$
	select case p_key
		when 'profile' then '92400000-0000-4000-8000-000000000010'::uuid
		when 'owner' then '92400000-0000-4000-8000-000000000001'::uuid
		when 'a' then (current_setting('qorpera_test.base_connection')::jsonb ->> 'connection_id')::uuid
		when 'aBinding' then (current_setting('qorpera_test.base_sponsor')::jsonb ->> 'binding_id')::uuid
		when 'b' then (current_setting('qorpera_test.a6_connection')::jsonb ->> 'connection_id')::uuid
		when 'bBinding' then (current_setting('qorpera_test.a6_sponsor')::jsonb ->> 'binding_id')::uuid
		else current_setting('qorpera_test.a6_' || p_key)::uuid end
$$;
-- A usage reading of a login's version 2 taken a second ago: its window is p_used percent used and resets in two days.
create function pg_temp.a6_reading(p_connection uuid, p_used numeric) returns void language sql as $$
	insert into public.qorpera_native_provider_account_metadata(connection_id,connection_version,provider_account_usage)
	values (p_connection, 2, jsonb_build_object('observedAt', statement_timestamp() - interval '1 second',
		'windows', jsonb_build_array(jsonb_build_object('id','primary','label','Week','usedPercent',p_used,
			'resetAt',to_char((statement_timestamp() + interval '2 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))))
	on conflict (connection_id, connection_version) do update set provider_account_usage = excluded.provider_account_usage
$$;

-- The previous text (20260930548000, 20260930580000), with its names changed and nothing else.
create function pg_temp.a6_old_live(p_profile_id uuid, p_user_id uuid)
returns table(connection_id uuid, binding_id uuid, sponsor_version bigint, compute_identity_id uuid, remaining numeric)
language sql stable security definer set search_path = '' as $$
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
        and (not exists (select 1 from public.qorpera_model_login_links link where link.credential_capsule_id = capsule.id)
            or exists (select 1 from public.qorpera_model_login_links link
                join public.qorpera_model_logins login on login.id = link.login_id
                where link.credential_capsule_id = capsule.id and link.profile_id = p_profile_id
                    and link.owner_user_id = p_user_id and login.owner_user_id = p_user_id
                    and login.principal_id = public.qorpera_company_account_vault(p_profile_id)
                    and public.qorpera_account_model_logins_enabled()))
$$;
create function pg_temp.a6_old_select(p_profile_id uuid, p_session_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_saved public.qorpera_member_session_accounts%rowtype; v_choice record;
    v_current uuid;
begin
    if auth.role() is distinct from 'authenticated' or v_user is null
        or not public.qorpera_can_read_session(p_session_id) then
        raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    perform 1 from public.qorpera_shared_sessions where id = p_session_id and profile_id = p_profile_id for update;
    if not found then raise exception 'Conversation accounts unavailable' using errcode = '42501'; end if;
    select candidate.* into v_choice
        from public.qorpera_member_session_waiting_turns(p_profile_id,p_session_id,v_user) as waiting
        join pg_temp.a6_old_live(p_profile_id,v_user) as candidate
            on candidate.connection_id = waiting.connection_id
        order by waiting.created_at,waiting.request_id,candidate.binding_id limit 1;
    if found then
        insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
            values(p_profile_id,p_session_id,v_user,v_choice.connection_id,v_choice.binding_id)
            on conflict(profile_id,session_id,user_id) do update set
                connection_id = excluded.connection_id,sponsor_binding_id = excluded.sponsor_binding_id,
                selected_at = case when qorpera_member_session_accounts.connection_id = excluded.connection_id
                    then qorpera_member_session_accounts.selected_at else clock_timestamp() end;
        return v_choice.connection_id;
    end if;
    select * into v_saved from public.qorpera_member_session_accounts
        where profile_id = p_profile_id and session_id = p_session_id and user_id = v_user;
    if found then
        v_current := coalesce(public.qorpera_sponsor_binding_connection(v_saved.sponsor_binding_id), v_saved.connection_id);
        select * into v_choice from pg_temp.a6_old_live(p_profile_id,v_user) candidate
            where candidate.connection_id = v_current
            order by (candidate.binding_id = v_saved.sponsor_binding_id) desc,candidate.binding_id limit 1;
        if found then
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
    select * into v_choice from public.qorpera_eligible_member_accounts(p_profile_id,v_user) candidate
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

-- The saved row, and whether its selected_at moved from p_before's.
create function pg_temp.a6_row(p_session uuid, p_before jsonb default null) returns jsonb language sql as $$
	select jsonb_build_object('connection', saved.connection_id, 'binding', saved.sponsor_binding_id,
		'selected_at', saved.selected_at,
		'moved', p_before is null or saved.selected_at is distinct from (p_before ->> 'selected_at')::timestamptz)
	from public.qorpera_member_session_accounts as saved
	where saved.profile_id = pg_temp.a6('profile') and saved.session_id = p_session and saved.user_id = pg_temp.a6('owner')
$$;
create function pg_temp.a6_live_answer(p_old boolean) returns jsonb language plpgsql as $$
declare v jsonb;
begin
	if p_old then
		select coalesce(jsonb_agg(to_jsonb(live) order by live.connection_id, live.binding_id), '[]') into v
		from pg_temp.a6_old_live(pg_temp.a6('profile'), pg_temp.a6('owner')) as live;
	else
		select coalesce(jsonb_agg(to_jsonb(live) order by live.connection_id, live.binding_id), '[]') into v
		from public.qorpera_member_live_accounts(pg_temp.a6('profile'), pg_temp.a6('owner')) as live;
	end if;
	return v;
end $$;
-- One world: the previous text and the new text, each undone. Same answer, same row, and the same live logins with their room.
create function pg_temp.a6_world(p_label text, p_session uuid) returns uuid language plpgsql as $$
declare v_before jsonb := pg_temp.a6_row(p_session); v_old_answer uuid; v_old_row jsonb; v_new uuid; v_new_row jsonb;
begin
	perform pg_temp.base_assert(pg_temp.a6_live_answer(true) = pg_temp.a6_live_answer(false),
		p_label || ': the live logins differ: ' || pg_temp.a6_live_answer(true)::text || ' against ' || pg_temp.a6_live_answer(false)::text);
	perform pg_temp.base_claims('authenticated', pg_temp.a6('owner'));
	begin
		v_old_answer := pg_temp.a6_old_select(pg_temp.a6('profile'), p_session);
		v_old_row := pg_temp.a6_row(p_session, v_before);
		raise exception 'undo' using errcode = 'A6000';
	exception when sqlstate 'A6000' then null;
	end;
	begin
		v_new := public.qorpera_select_member_session_account(pg_temp.a6('profile'), p_session);
		v_new_row := pg_temp.a6_row(p_session, v_before);
		raise exception 'undo' using errcode = 'A6000';
	exception when sqlstate 'A6000' then null;
	end;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_new is not distinct from v_old_answer, p_label || ': the answer differs');
	perform pg_temp.base_assert((v_new_row - 'selected_at') is not distinct from (v_old_row - 'selected_at'),
		p_label || ': the saved row differs: ' || coalesce(v_old_row::text, 'none') || ' against ' || coalesce(v_new_row::text, 'none'));
	return v_new;
end $$;
-- p_lock_seen is false for a thread a pass made: this transaction may hold its row, so a lock would not show.
create function pg_temp.a6_locked(p_session uuid) returns boolean language sql as $$
	select xmax::text <> '0' from public.qorpera_shared_sessions where id = p_session
$$;
create function pg_temp.a6_place(p_session uuid) returns text language sql as $$
	select ctid::text from public.qorpera_member_session_accounts
	where profile_id = pg_temp.a6('profile') and session_id = p_session and user_id = pg_temp.a6('owner')
$$;
create function pg_temp.a6_calls(p_name text) returns bigint language sql as $$
	select coalesce(sum(calls), 0) from pg_stat_xact_user_functions where funcname = p_name
$$;
-- A call that changes nothing: the answer, with no row moved, none locked and no room asked for (p_room: it may ask).
create function pg_temp.a6_quiet(p_label text, p_session uuid, p_room boolean default false, p_lock_seen boolean default true)
returns uuid language plpgsql as $$
declare v_place text := pg_temp.a6_place(p_session); v_room bigint := pg_temp.a6_calls('qorpera_native_account_remaining');
	v_answer uuid;
begin
	if p_lock_seen then
		perform pg_temp.base_assert(not pg_temp.a6_locked(p_session), p_label || ': this transaction holds the row, so a lock would not show');
	end if;
	perform pg_temp.base_claims('authenticated', pg_temp.a6('owner'));
	v_answer := public.qorpera_select_member_session_account(pg_temp.a6('profile'), p_session);
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(pg_temp.a6_place(p_session) is not distinct from v_place, p_label || ': the saved row was rewritten');
	if p_lock_seen then
		perform pg_temp.base_assert(not pg_temp.a6_locked(p_session), p_label || ': the conversation''s row was locked');
	end if;
	if not p_room then
		perform pg_temp.base_assert(pg_temp.a6_calls('qorpera_native_account_remaining') = v_room,
			p_label || ': it asked for the room ' || (pg_temp.a6_calls('qorpera_native_account_remaining') - v_room)::text || ' times');
	end if;
	return v_answer;
end $$;
-- A call that changes something takes the conversation's row first, as before. Undone.
create function pg_temp.a6_writes(p_label text, p_session uuid, p_lock_seen boolean default true) returns uuid language plpgsql as $$
declare v_place text := pg_temp.a6_place(p_session); v_answer uuid; v_after text; v_locked boolean;
begin
	begin
		if p_lock_seen then
			perform pg_temp.base_assert(not pg_temp.a6_locked(p_session), p_label || ': this transaction holds the row, so a lock would not show');
		end if;
		perform pg_temp.base_claims('authenticated', pg_temp.a6('owner'));
		v_answer := public.qorpera_select_member_session_account(pg_temp.a6('profile'), p_session);
		perform pg_temp.base_claims('service_role');
		v_after := pg_temp.a6_place(p_session);
		v_locked := pg_temp.a6_locked(p_session);
		raise exception 'undo' using errcode = 'A6000';
	exception when sqlstate 'A6000' then null;
	end;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(v_after is distinct from v_place, p_label || ': nothing was written');
	if p_lock_seen then
		perform pg_temp.base_assert(v_locked, p_label || ': a write did not take the conversation''s row');
	end if;
	return v_answer;
end $$;
-- A new conversation with this login saved, without triggers (see a6_conversation).
create function pg_temp.a6_saved(p_key text, p_connection uuid, p_binding uuid) returns void language plpgsql as $$
begin
	perform pg_temp.a6_conversation(p_key);
	perform pg_temp.a6_save(pg_temp.a6(p_key), p_connection, p_binding);
end $$;
create function pg_temp.a6_save(p_session uuid, p_connection uuid, p_binding uuid) returns void language plpgsql as $$
begin
	perform set_config('session_replication_role', 'replica', true);
	insert into public.qorpera_member_session_accounts(profile_id,session_id,user_id,connection_id,sponsor_binding_id)
	values (pg_temp.a6('profile'), p_session, pg_temp.a6('owner'), p_connection, p_binding)
	on conflict (profile_id,session_id,user_id) do update set connection_id = excluded.connection_id,
		sponsor_binding_id = excluded.sponsor_binding_id;
	perform set_config('session_replication_role', 'origin', true);
end $$;
create function pg_temp.a6_set_status(p_connection uuid, p_status text) returns void language sql as $$
	update public.qorpera_provider_connections set status = p_status where id = p_connection
$$;

-- The checks start here.
select pg_temp.a6_reading(pg_temp.a6('b'), 20);

-- 1. A new conversation's first choice: B, with room. It is written, under the lock, and the same on both texts.
select pg_temp.a6_conversation('first');
select pg_temp.base_assert(pg_temp.a6_writes('first choice', pg_temp.a6('first')) = pg_temp.a6('b'), 'a first choice did not write B');
select pg_temp.base_assert(pg_temp.a6_world('first choice', pg_temp.a6('first')) = pg_temp.a6('b'), 'a first choice did not take B');

-- 2. Nothing to change, the poll: the saved login, with no write, no lock and no room asked for. Also at its usage limit.
select pg_temp.a6_saved('savedB', pg_temp.a6('b'), pg_temp.a6('bBinding'));
select pg_temp.base_assert(pg_temp.a6_quiet('saved B', pg_temp.a6('savedB')) = pg_temp.a6('b'), 'the poll did not answer B');
select pg_temp.base_assert(pg_temp.a6_world('saved B', pg_temp.a6('savedB')) = pg_temp.a6('b'), 'saved B moved');
select pg_temp.a6_saved('savedA', pg_temp.a6('a'), pg_temp.a6('aBinding'));
select pg_temp.base_assert(pg_temp.a6_quiet('saved A', pg_temp.a6('savedA')) = pg_temp.a6('a'), 'the poll did not answer A');
select pg_temp.base_assert(pg_temp.a6_world('saved A', pg_temp.a6('savedA')) = pg_temp.a6('a'), 'saved A moved');
select pg_temp.a6_reading(pg_temp.a6('a'), 100);
select pg_temp.a6_saved('limit', pg_temp.a6('a'), pg_temp.a6('aBinding'));
select pg_temp.base_assert(pg_temp.a6_quiet('saved A, at its limit', pg_temp.a6('limit')) = pg_temp.a6('a'), 'the poll left A at its limit');
select pg_temp.base_assert(pg_temp.a6_world('saved A, at its limit', pg_temp.a6('limit')) = pg_temp.a6('a'), 'A at its limit moved');
select pg_temp.a6_reading(pg_temp.a6('a'), 30);

-- 3. A saved binding that pays with another connection now: the row follows, its selected_at with it, under the lock.
select pg_temp.a6_saved('moved', pg_temp.a6('a'), pg_temp.a6('bBinding'));
select pg_temp.base_assert(pg_temp.a6_writes('binding moved on', pg_temp.a6('moved')) = pg_temp.a6('b'), 'the write did not answer B');
select pg_temp.base_assert(pg_temp.a6_world('binding moved on', pg_temp.a6('moved')) = pg_temp.a6('b'), 'the row did not follow its binding');
-- The same login on an older binding of the member's: the row takes the binding, with no new selected_at.
select pg_temp.a6_saved('rebound', pg_temp.a6('b'), pg_temp.a6('aBinding'));
select pg_temp.base_assert(pg_temp.a6_world('rebound', pg_temp.a6('rebound')) = pg_temp.a6('a'), 'the row did not follow its binding back');

-- 4. A login that cannot pay right now stays the conversation's; one the member disconnected leaves it with none. Neither writes.
select pg_temp.a6_set_status(pg_temp.a6('a'), 'disabled');
select pg_temp.a6_saved('disabled', pg_temp.a6('a'), pg_temp.a6('aBinding'));
select pg_temp.base_assert(pg_temp.a6_quiet('disabled', pg_temp.a6('disabled')) = pg_temp.a6('a'), 'the poll left a disabled login');
select pg_temp.base_assert(pg_temp.a6_world('disabled', pg_temp.a6('disabled')) = pg_temp.a6('a'), 'a disabled login left the conversation');
select pg_temp.a6_set_status(pg_temp.a6('a'), 'revoked');
select pg_temp.a6_saved('revoked', pg_temp.a6('a'), pg_temp.a6('aBinding'));
select pg_temp.base_assert(pg_temp.a6_quiet('revoked', pg_temp.a6('revoked')) is null, 'the poll kept a revoked login');
select pg_temp.base_assert(pg_temp.a6_world('revoked', pg_temp.a6('revoked')) is null, 'a revoked login stayed the conversation''s');
select pg_temp.a6_set_status(pg_temp.a6('a'), 'active');

-- 5. A turn waiting at its login's limit is the conversation's, over a saved other login; once saved, a poll leaves it.
-- Reading whether the turn waits asks for the room, as it did. The pass that made the thread may hold its row (no lock check).
select pg_temp.a6_reading(pg_temp.a6('a'), 100);
select pg_temp.a6_reading(pg_temp.a6('b'), 100);
select pg_temp.base_commit(pg_temp.base_owner(), 'a6-hire-dana', jsonb_build_array(
	pg_temp.base_hire('dana', '92400000-0000-4000-8000-000000000034', 'Dana'))) \g /dev/null
select pg_temp.base_materialize() \g /dev/null
select set_config('qorpera_test.a6_dana', (select session_id::text from public.qorpera_company_rooms
	where id = pg_temp.base_thread('92400000-0000-4000-8000-000000000034')), true) \g /dev/null
select set_config('qorpera_test.a6_waits', (select waiting.connection_id::text
	from public.qorpera_member_session_waiting_turns(pg_temp.a6('profile'), pg_temp.a6('dana'), pg_temp.a6('owner')) as waiting
	order by waiting.created_at limit 1), true) \g /dev/null
select pg_temp.base_assert(current_setting('qorpera_test.a6_waits') <> '', 'Dana''s kickoff does not wait');
create function pg_temp.a6_binding_of(p_connection uuid) returns uuid language sql as $$
	select case when p_connection = pg_temp.a6('a') then pg_temp.a6('aBinding') else pg_temp.a6('bBinding') end
$$;
create function pg_temp.a6_other(p_connection uuid) returns uuid language sql as $$
	select case when p_connection = pg_temp.a6('a') then pg_temp.a6('b') else pg_temp.a6('a') end
$$;
select pg_temp.a6_save(pg_temp.a6('dana'), pg_temp.a6_other(pg_temp.a6('waits')), pg_temp.a6_binding_of(pg_temp.a6_other(pg_temp.a6('waits'))));
select pg_temp.base_assert(pg_temp.a6_writes('waiting over a saved login', pg_temp.a6('dana'), false) = pg_temp.a6('waits'), 'the write did not answer the waiting turn''s login');
select pg_temp.base_assert(pg_temp.a6_world('waiting over a saved login', pg_temp.a6('dana')) = pg_temp.a6('waits'), 'the waiting turn''s login is not the conversation''s');
select pg_temp.a6_save(pg_temp.a6('dana'), pg_temp.a6('waits'), pg_temp.a6_binding_of(pg_temp.a6('waits')));
select pg_temp.base_assert(pg_temp.a6_quiet('waiting, saved', pg_temp.a6('dana'), true, false) = pg_temp.a6('waits'), 'the poll left the waiting turn''s login');
select pg_temp.base_assert(pg_temp.a6_world('waiting, saved', pg_temp.a6('dana')) = pg_temp.a6('waits'), 'waiting, saved moved');

-- 6. The authority comes first, whatever is saved, and the same refusal stands on every branch.
select pg_temp.base_claims('authenticated', pg_temp.a6('owner'));
select pg_temp.base_error(format('select public.qorpera_select_member_session_account(%L,%L)',
	'92400000-0000-4000-8000-0000000000ff', pg_temp.a6('savedB')), '42501', 'Conversation accounts unavailable');
select pg_temp.base_error(format('select public.qorpera_select_member_session_account(%L,%L)',
	pg_temp.a6('profile'), '92400000-0000-4000-8000-0000000000fe'), '42501', 'Conversation accounts unavailable');
select pg_temp.base_claims('authenticated', '92400000-0000-4000-8000-0000000000fd');
select pg_temp.base_error(format('select public.qorpera_select_member_session_account(%L,%L)',
	pg_temp.a6('profile'), pg_temp.a6('savedB')), '42501', 'Conversation accounts unavailable');
select pg_temp.base_claims('anon');
select pg_temp.base_error(format('select public.qorpera_select_member_session_account(%L,%L)',
	pg_temp.a6('profile'), pg_temp.a6('savedB')), '42501', 'Conversation accounts unavailable');
select pg_temp.base_claims('service_role');

-- 7. The new helper is the database's own, and the two functions carry the markers guards read.
select pg_temp.base_assert(not has_function_privilege('anon','public.qorpera_member_live_account_bindings(uuid,uuid)','execute')
	and not has_function_privilege('authenticated','public.qorpera_member_live_account_bindings(uuid,uuid)','execute')
	and not has_function_privilege('service_role','public.qorpera_member_live_account_bindings(uuid,uuid)','execute'),
	'API clients can call qorpera_member_live_account_bindings');
select pg_temp.base_assert(has_function_privilege('authenticated','public.qorpera_select_member_session_account(uuid,uuid)','execute')
	and not has_function_privilege('anon','public.qorpera_select_member_session_account(uuid,uuid)','execute'),
	'the selection''s grants moved');
select pg_temp.base_assert(not has_function_privilege('anon','public.qorpera_member_live_accounts(uuid,uuid)','execute')
	and not has_function_privilege('authenticated','public.qorpera_member_live_accounts(uuid,uuid)','execute')
	and not has_function_privilege('service_role','public.qorpera_member_live_accounts(uuid,uuid)','execute'),
	'API clients can call qorpera_member_live_accounts');
select pg_temp.base_assert(position(m in pg_get_functiondef('public.qorpera_select_member_session_account(uuid,uuid)'::regprocedure)) > 0,
	'the selection lost marker ' || m) from unnest(array['20260930059000','20260930559000','20260930580000','20260930606000']) as m;

rollback;
