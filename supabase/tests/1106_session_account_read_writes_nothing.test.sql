-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"

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

-- The saved row, and whether its selected_at moved from p_before's.
create function pg_temp.a6_row(p_session uuid, p_before jsonb default null) returns jsonb language sql as $$
	select jsonb_build_object('connection', saved.connection_id, 'binding', saved.sponsor_binding_id,
		'selected_at', saved.selected_at,
		'moved', p_before is null or saved.selected_at is distinct from (p_before ->> 'selected_at')::timestamptz)
	from public.qorpera_member_session_accounts as saved
	where saved.profile_id = pg_temp.a6('profile') and saved.session_id = p_session and saved.user_id = pg_temp.a6('owner')
$$;
create function pg_temp.a6_world(p_label text, p_session uuid) returns uuid language plpgsql as $$
declare v_before jsonb := pg_temp.a6_row(p_session); v_new uuid; v_new_row jsonb;
begin
	perform pg_temp.base_claims('authenticated', pg_temp.a6('owner'));
	begin
		v_new := public.qorpera_select_member_session_account(pg_temp.a6('profile'), p_session);
		v_new_row := pg_temp.a6_row(p_session, v_before);
		raise exception 'undo' using errcode = 'A6000';
	exception when sqlstate 'A6000' then null;
	end;
	perform pg_temp.base_claims('service_role');
	perform pg_temp.base_assert(case when v_new is null then (v_new_row - 'moved') is not distinct from (v_before - 'moved')
		else (v_new_row ->> 'connection')::uuid = v_new and (v_new_row ->> 'binding')::uuid
			= case when v_new = pg_temp.a6('a') then pg_temp.a6('aBinding') else pg_temp.a6('bBinding') end end,
		p_label || ': the saved row is not the answer: ' || coalesce(v_new_row::text, 'none'));
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
create function pg_temp.a6_quiet(p_label text, p_session uuid, p_lock_seen boolean default true)
returns uuid language plpgsql as $$
declare v_place text := pg_temp.a6_place(p_session); v_answer uuid;
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

select pg_temp.a6_conversation('first');
select pg_temp.base_assert(pg_temp.a6_writes('first choice', pg_temp.a6('first')) = pg_temp.a6('b'), 'a first choice did not write B');
select pg_temp.base_assert(pg_temp.a6_world('first choice', pg_temp.a6('first')) = pg_temp.a6('b'), 'a first choice did not take B');

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
select pg_temp.base_assert(pg_temp.a6_quiet('waiting, saved', pg_temp.a6('dana'), false) = pg_temp.a6('waits'), 'the poll left the waiting turn''s login');
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

rollback;
