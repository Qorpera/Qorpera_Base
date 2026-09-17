begin;
-- 2026-09-17 amendment: identity recovery inside a member login.
create function pg_temp.claims(p_role text,p_user uuid default null) returns void language sql as $$
  select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void $$;
create function pg_temp.ok(p_value boolean,p_message text) returns void language plpgsql as $$
begin if p_value is distinct from true then raise exception '%',p_message; end if; end $$;
create function pg_temp.denied(p_statement text) returns void language plpgsql as $$
begin
  begin execute p_statement; exception when insufficient_privilege or object_not_in_prerequisite_state or unique_violation or invalid_parameter_value then return; end;
  raise exception 'Accepted unauthorized or invalid state: %',p_statement;
end $$;

insert into auth.users(id,email) values
  ('30000000-0000-4000-8000-000000000001','lra-owner@example.test'),
  ('30000000-0000-4000-8000-000000000002','lra-member@example.test'),
  ('30000000-0000-4000-8000-000000000003','lra-other@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values ('30000000-0000-4000-8000-000000000010','Login recovery fixture','30000000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
  ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','lra-owner@example.test','Owner','owner'),
  ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000002','lra-member@example.test','Member','contributor'),
  ('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000003','lra-other@example.test','Other','contributor');
insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,owner_user_id,client_identity_id,display_name) values
  ('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000010','member','30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000020','Member identity');
insert into public.qorpera_identity_recovery_authorities(id,profile_id,signing_public_key,wrapping_public_key,service_origin,capability_sha256)
  values ('30000000-0000-4000-8000-000000000030','30000000-0000-4000-8000-000000000010',repeat('A',59),repeat('A',550),'https://recovery.example.test',repeat('c',64));
select pg_temp.claims('service_role'); set local role service_role;
select public.qorpera_configure_runtime_node('{"schema":"qorpera.runtime-node-policy/v1","nodeId":"30000000-0000-4000-8000-000000000040","machineIdSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","label":"lra-node","cpuMillis":32000,"memoryBytes":137438953472,"headroomCpuMillis":8000,"headroomMemoryBytes":68719476736,"standardCpuMillis":8000,"standardMemoryBytes":17179869184,"enabled":true}'::jsonb,0);
reset role;

-- A member begins a login; a backup exists (established identity).
select pg_temp.claims('authenticated','30000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('t.login',(public.qorpera_begin_native_provider_login('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000050',
  '30000000-0000-4000-8000-000000000051','30000000-0000-4000-8000-000000000020','openai','codex-cli',repeat('1',64),3600)->>'login_id'),true);
reset role;
select pg_temp.claims('service_role'); set local role service_role;
select public.qorpera_prepare_identity_key_backup('30000000-0000-4000-8000-000000000030',repeat('c',64),current_setting('t.login')::uuid,repeat('1',64),repeat('a',64));
select public.qorpera_complete_identity_key_backup('30000000-0000-4000-8000-000000000030',repeat('c',64),current_setting('t.login')::uuid,repeat('1',64),repeat('a',64),1,repeat('b',64),1024);
select public.qorpera_complete_native_provider_login(current_setting('t.login')::uuid,repeat('1',64),'30000000-0000-4000-8000-000000000052',
  'synthetic://encrypted-capsule',repeat('e',64),'synthetic','test','recovery-fixture/v1',
  '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
select pg_temp.ok(not (public.qorpera_identity_recovery_runtime_state('30000000-0000-4000-8000-000000000020')->>'canInitialize')::boolean,'identity should be established');

-- Registrar enrolment is service-role only and bound to a known node.
select pg_temp.denied($q$select public.qorpera_enroll_identity_recovery_registrar('30000000-0000-4000-8000-000000000099',repeat('9',64))$q$);
select public.qorpera_enroll_identity_recovery_registrar('30000000-0000-4000-8000-000000000040',repeat('7',64));
-- Registration through the registrar: wrong capability, foreign node, then success.
select pg_temp.denied($q$select public.qorpera_register_identity_recovery_target('30000000-0000-4000-8000-000000000030',repeat('c',64),
  '30000000-0000-4000-8000-000000000060','30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000040',repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64),
  '30000000-0000-4000-8000-000000000040',repeat('8',64))$q$);
select pg_temp.denied($q$select public.qorpera_register_identity_recovery_target('30000000-0000-4000-8000-000000000030',repeat('c',64),
  '30000000-0000-4000-8000-000000000060','30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000041',repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64),
  '30000000-0000-4000-8000-000000000040',repeat('7',64))$q$);
select pg_temp.ok((public.qorpera_register_identity_recovery_target('30000000-0000-4000-8000-000000000030',repeat('c',64),
  '30000000-0000-4000-8000-000000000060','30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000040',repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64),
  '30000000-0000-4000-8000-000000000040',repeat('7',64))->>'registrarNodeId')='30000000-0000-4000-8000-000000000040','registrar registration failed');
reset role;

-- A second login by the identity's member (the one that needs recovery), and one by an unrelated member.
select pg_temp.claims('authenticated','30000000-0000-4000-8000-000000000002'); set local role authenticated;
select set_config('t.login2',(public.qorpera_begin_native_provider_login('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000053',
  '30000000-0000-4000-8000-000000000054','30000000-0000-4000-8000-000000000020','openai','codex-cli',repeat('2',64),3600)->>'login_id'),true);
reset role;
-- Login-bound request: authenticated callers are refused; the gateway (service role) succeeds and the recovery self-activates.
select pg_temp.claims('authenticated','30000000-0000-4000-8000-000000000002'); set local role authenticated;
select pg_temp.denied(format('select public.qorpera_request_login_identity_recovery(%L,%L,%L,%L)',current_setting('t.login2'),'30000000-0000-4000-8000-000000000060','30000000-0000-4000-8000-000000000070','nas'));
reset role;
select pg_temp.claims('service_role'); set local role service_role;
select set_config('t.recovery',public.qorpera_request_login_identity_recovery(current_setting('t.login2')::uuid,'30000000-0000-4000-8000-000000000060','30000000-0000-4000-8000-000000000070','nas')::text,true);
select pg_temp.ok((current_setting('t.recovery')::jsonb->>'status')='approved','login recovery did not self-activate for the identity owner');
select pg_temp.ok((current_setting('t.recovery')::jsonb->>'backupSha256')=repeat('b',64) and (current_setting('t.recovery')::jsonb->>'serviceOrigin')='https://recovery.example.test'
  and (current_setting('t.recovery')::jsonb->>'loginId')=current_setting('t.login2'),'login recovery answer lacks the restore inputs');
-- Idempotent for the same client request id; a different target for the same id is refused.
select pg_temp.ok((public.qorpera_request_login_identity_recovery(current_setting('t.login2')::uuid,'30000000-0000-4000-8000-000000000060','30000000-0000-4000-8000-000000000070','nas')->>'recoveryId')
  =(current_setting('t.recovery')::jsonb->>'recoveryId'),'login recovery not idempotent');
select pg_temp.denied(format('select public.qorpera_request_login_identity_recovery(%L,%L,%L,%L)',current_setting('t.login2'),'30000000-0000-4000-8000-000000000061','30000000-0000-4000-8000-000000000070','nas'));
-- The identity is now fenced: another login session cannot be inserted until the recovery completes.
reset role;
select pg_temp.claims('authenticated','30000000-0000-4000-8000-000000000003'); set local role authenticated;
select pg_temp.denied($q$select public.qorpera_begin_native_provider_login('30000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000055',
  '30000000-0000-4000-8000-000000000056','30000000-0000-4000-8000-000000000020','openai','codex-cli',repeat('3',64),3600)$q$);
reset role;
-- Chooser: with no gateways the answer is NO_GATEWAY and carries the identity homes of the login's identity.
select pg_temp.claims('service_role'); set local role service_role;
select pg_temp.ok((public.qorpera_runtime_login_gateway_choose(repeat('2',64))->>'reason')='NO_GATEWAY','chooser without gateways');
select pg_temp.ok(jsonb_typeof(public.qorpera_runtime_login_gateway_choose(repeat('2',64))->'identityHomes')='array','chooser lacks identity homes');
reset role;
select pg_temp.claims('authenticated','30000000-0000-4000-8000-000000000001'); set local role authenticated;
select pg_temp.denied($q$select public.qorpera_runtime_login_gateway_choose(repeat('2',64))$q$);
reset role;
select 'LOGIN_RECOVERY_AUTOMATION_OK' as result;
rollback;
