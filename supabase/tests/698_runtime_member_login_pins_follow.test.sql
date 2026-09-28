-- @fixture 300_runtime_wake_bus.test.sql until "-- END WAKE FIXTURE"
-- A member's pinned login follows them to their new login (20260928231000). The owner's routine
-- pins the owner's first login; the owner signs in again (a second connection) and the vault
-- moves the pins: the binding gains a new version on the new login, routine wakes created
-- afterwards take it, and they are still admitted after the old login is revoked.
reset role;

do $$
begin
	-- Gated by grants: the service role, or a SECURITY DEFINER caller such as the vault's switch-off.
	if has_function_privilege('anon', 'public.qorpera_move_member_login_pins(uuid,uuid,uuid,uuid)', 'EXECUTE')
		or has_function_privilege('authenticated', 'public.qorpera_move_member_login_pins(uuid,uuid,uuid,uuid)', 'EXECUTE')
		or has_function_privilege('qorpera_secret_broker', 'public.qorpera_move_member_login_pins(uuid,uuid,uuid,uuid)', 'EXECUTE')
		or not has_function_privilege('service_role', 'public.qorpera_move_member_login_pins(uuid,uuid,uuid,uuid)', 'EXECUTE') then
		raise exception 'the login pins move is not gated to the control plane';
	end if;
end
$$;

-- Bob's routine, saved by the owner on the owner's first login.
select set_config('qorpera_test.pins_routine',pg_temp.wake_routine('30000000-0000-4000-8000-000000000031',
	'{"id":"tick","kind":"schedule","intervalMinutes":60,"replyPolicy":"optional"}')::text,true);

-- The owner signs in again: a second connection on the same compute identity, not yet consented
-- for unattended use.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('qorpera_test.pins_login',public.qorpera_begin_native_provider_login(
	'30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000851','30000000-0000-4000-8000-000000000852',
	(current_setting('qorpera_test.wake_identity')::jsonb ->> 'compute_identity_id')::uuid,'openai','codex-cli',repeat('e',64),900)::text,true);
reset role;
select pg_temp.path_claims('service_role');
set local role service_role;
select set_config('qorpera_test.pins_connection',public.qorpera_complete_native_provider_login(
	(current_setting('qorpera_test.pins_login')::jsonb ->> 'login_id')::uuid,repeat('e',64),'30000000-0000-4000-8000-000000000860',
	'object://native-capsules/30000000-0000-4000-8000-000000000860',repeat('f',64),'fixture-openai-account','personal-subscription',
	'qorpera-native-provider-consent/v1',
	'{"monthly_microusd":1000000000,"reservation_microusd":1000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":32}')::text,true);
reset role;

do $$
declare
	v_profile uuid := '30000000-0000-4000-8000-000000000010';
	v_owner uuid := '30000000-0000-4000-8000-000000000001';
	v_old uuid := (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid;
	v_new uuid := (current_setting('qorpera_test.pins_connection')::jsonb ->> 'connection_id')::uuid;
	v_result jsonb; v_refused boolean;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	-- Invalid moves: the same login, or a login the member does not own.
	foreach v_result in array array[
		jsonb_build_object('member',v_owner,'old',v_old,'new',v_old),
		jsonb_build_object('member','30000000-0000-4000-8000-000000000002','old',v_old,'new',v_new)] loop
		v_refused := false;
		begin
			perform public.qorpera_move_member_login_pins(v_profile,(v_result ->> 'member')::uuid,
				(v_result ->> 'old')::uuid,(v_result ->> 'new')::uuid);
		exception when invalid_parameter_value then v_refused := true;
		end;
		if not v_refused then raise exception 'an invalid login pins move was accepted: %', v_result; end if;
	end loop;
	-- The new login does not allow unattended use yet: nothing moves.
	v_result := public.qorpera_move_member_login_pins(v_profile, v_owner, v_old, v_new);
	if v_result ->> 'status' <> 'refused' or v_result ->> 'reason' <> 'new_login_not_autonomous'
		or (select count(*) from public.qorpera_execution_sponsor_versions
			where binding_id = (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid) <> 1 then
		raise exception 'a move onto a login without unattended consent changed something: %', v_result;
	end if;
end
$$;

-- Unattended use is granted by default when an account is bound (2026-09-19/20 amendment).
insert into public.qorpera_provider_connection_versions
select (jsonb_populate_record(null::public.qorpera_provider_connection_versions,
	to_jsonb(v) || '{"version":2,"allow_autonomous":true}'::jsonb)).*
from public.qorpera_provider_connection_versions v
where connection_id = (current_setting('qorpera_test.pins_connection')::jsonb ->> 'connection_id')::uuid and version = 1;

do $$
declare
	v_profile uuid := '30000000-0000-4000-8000-000000000010';
	v_owner uuid := '30000000-0000-4000-8000-000000000001';
	v_old uuid := (current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid;
	v_new uuid := (current_setting('qorpera_test.pins_connection')::jsonb ->> 'connection_id')::uuid;
	v_binding uuid := (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid;
	v_result jsonb; v_again jsonb;
begin
	perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
	v_result := public.qorpera_move_member_login_pins(v_profile, v_owner, v_old, v_new);
	if v_result ->> 'status' <> 'moved' or not exists (select 1 from jsonb_array_elements(v_result -> 'bindings') moved
			where moved.value ->> 'bindingId' = v_binding::text and (moved.value ->> 'fromVersion')::bigint = 1
				and (moved.value ->> 'toVersion')::bigint = 2)
		or (v_result ->> 'routineVersions')::integer < 1 then
		raise exception 'the owner''s pins did not move: %', v_result;
	end if;
	if not exists (select 1 from public.qorpera_execution_sponsor_versions
		where binding_id = v_binding and version = 2 and sponsor_kind = 'member_connection'
			and provider_connection_id = v_new and provider_connection_version = 2 and allow_autonomous
			and created_by_user_id = v_owner) then
		raise exception 'the moved binding version does not pay with the new login';
	end if;
	-- Nothing still pays with the old login; a second move changes nothing.
	if exists (select 1 from public.qorpera_execution_sponsor_bindings binding
		join public.qorpera_execution_sponsor_versions sponsor on sponsor.binding_id = binding.id
			and sponsor.version = (select max(version) from public.qorpera_execution_sponsor_versions where binding_id = binding.id)
		where binding.profile_id = v_profile and sponsor.provider_connection_id = v_old) then
		raise exception 'a binding still pays with the old login';
	end if;
	v_again := public.qorpera_move_member_login_pins(v_profile, v_owner, v_old, v_new);
	if v_again ->> 'status' <> 'moved' or jsonb_array_length(v_again -> 'bindings') <> 0 then
		raise exception 'a repeated move was not idempotent: %', v_again;
	end if;
	-- The follow relation: the pinned version itself, or a later version of the same owner.
	if not public.qorpera_sponsor_version_follows(v_binding,1,1) or not public.qorpera_sponsor_version_follows(v_binding,1,2)
		or public.qorpera_sponsor_version_follows(v_binding,2,1) or public.qorpera_sponsor_version_follows(v_binding,1,3)
		or public.qorpera_live_sponsor_version(v_binding,1) <> 2 then
		raise exception 'the pinned version does not follow the owner''s new login';
	end if;
end
$$;

-- The owner disconnects the old login. A routine wake created now takes the new version and is admitted.
select pg_temp.path_claims('authenticated','30000000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_revoke_native_provider_connection('30000000-0000-4000-8000-000000000010',
	(current_setting('qorpera_test.wake_connection')::jsonb ->> 'connection_id')::uuid);
reset role;
select pg_temp.path_claims('service_role');
do $$
declare v_wake public.qorpera_wake_occurrences%rowtype;
	v_id uuid := pg_temp.wake_schedule(current_setting('qorpera_test.pins_routine')::jsonb,'pins-1');
begin
	select * into strict v_wake from public.qorpera_wake_occurrences where id = v_id;
	if v_wake.status <> 'queued' or v_wake.sponsor_binding_id <> (current_setting('qorpera_test.wake_sponsor')::jsonb ->> 'binding_id')::uuid
		or v_wake.sponsor_version <> 2 then
		raise exception 'a routine wake after the move did not take the new login: %', row_to_json(v_wake);
	end if;
	if not public.qorpera_wake_authorized(v_wake) then
		raise exception 'a routine wake on the moved login is not admitted';
	end if;
end
$$;

rollback;
