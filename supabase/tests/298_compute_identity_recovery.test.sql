begin;

create function pg_temp.recovery_claims(p_role text,p_user uuid default null)
returns void language sql as $$
  select set_config('request.jwt.claims',jsonb_build_object('role',p_role,'sub',p_user)::text,true)::text::void
$$;
create function pg_temp.assert_recovery(p_value boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_value is distinct from true then raise exception '%',p_message; end if;
end
$$;
create function pg_temp.recovery_denied(p_statement text)
returns void language plpgsql as $$
begin
  begin execute p_statement;
  exception when insufficient_privilege or object_not_in_prerequisite_state or unique_violation then return;
  end;
  raise exception 'Recovery accepted unauthorized or rebound state';
end
$$;

insert into auth.users(id,email) values
  ('29800000-0000-4000-8000-000000000001','recovery-owner@example.test'),
  ('29800000-0000-4000-8000-000000000002','recovery-member@example.test'),
  ('29800000-0000-4000-8000-000000000003','recovery-admin@example.test'),
  ('29800000-0000-4000-8000-000000000004','recovery-outsider@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('29800000-0000-4000-8000-000000000010','Recovery fixture','29800000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
  ('29800000-0000-4000-8000-000000000010','29800000-0000-4000-8000-000000000001','recovery-owner@example.test','Owner','owner'),
  ('29800000-0000-4000-8000-000000000010','29800000-0000-4000-8000-000000000002','recovery-member@example.test','Member','contributor'),
  ('29800000-0000-4000-8000-000000000010','29800000-0000-4000-8000-000000000003','recovery-admin@example.test','Admin','admin');
-- A folder-v2 company (the company folder core).
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
values ('29800000-0000-4000-8000-000000000011','29800000-0000-4000-8000-000000000010','Recovery fixture',1,'29800000-0000-4000-8000-000000000001');
select pg_temp.recovery_claims('service_role');
select public.qorpera_folder_enable('29800000-0000-4000-8000-000000000011') \g /dev/null
select pg_temp.assert_recovery(public.qorpera_company_is_folder_v2('29800000-0000-4000-8000-000000000010'),'Recovery company is not a folder-v2 company');
select set_config('request.jwt.claims','',true) \g /dev/null
insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,owner_user_id,client_identity_id,display_name)
values
  ('29800000-0000-4000-8000-000000000020','29800000-0000-4000-8000-000000000010','member','29800000-0000-4000-8000-000000000002','29800000-0000-4000-8000-000000000020','Member identity'),
  ('29800000-0000-4000-8000-000000000021','29800000-0000-4000-8000-000000000010','company',null,'29800000-0000-4000-8000-000000000021','Company identity');
-- Public-key shape fixtures only; real SPKI/algorithm/envelope verification is
-- exercised in the crypto and service tests, not faked as SQL cryptography.
insert into public.qorpera_identity_recovery_authorities(id,profile_id,signing_public_key,wrapping_public_key,service_origin,capability_sha256)
values ('29800000-0000-4000-8000-000000000030','29800000-0000-4000-8000-000000000010',repeat('A',59),repeat('A',550),'https://recovery.example.test',repeat('c',64));

select pg_temp.recovery_claims('authenticated','29800000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.recovery_login',(public.qorpera_begin_native_provider_login(
  '29800000-0000-4000-8000-000000000010','29800000-0000-4000-8000-000000000050',
  '29800000-0000-4000-8000-000000000051','29800000-0000-4000-8000-000000000020',
  'openai','codex-cli',repeat('d',64),3600)->>'login_id'),true);
reset role;
-- RECOVERY_NATIVE_LOGIN_FIXTURE_READY
select pg_temp.recovery_claims('service_role');
set local role service_role;
select pg_temp.assert_recovery((public.qorpera_identity_recovery_runtime_state('29800000-0000-4000-8000-000000000020')->>'canInitialize')::boolean,'New identity could not initialize');
select pg_temp.recovery_denied(format(
  'select public.qorpera_prepare_identity_key_backup(%L,%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('e',64),current_setting('qorpera_test.recovery_login'),repeat('d',64),repeat('a',64)));
select public.qorpera_prepare_identity_key_backup('29800000-0000-4000-8000-000000000030',repeat('c',64),
  current_setting('qorpera_test.recovery_login')::uuid,repeat('d',64),repeat('a',64));
select pg_temp.assert_recovery(not (public.qorpera_identity_recovery_runtime_state('29800000-0000-4000-8000-000000000020')->>'canInitialize')::boolean,'Prepared key history permitted silent replacement');
select public.qorpera_complete_identity_key_backup('29800000-0000-4000-8000-000000000030',repeat('c',64),
  current_setting('qorpera_test.recovery_login')::uuid,repeat('d',64),repeat('a',64),1,repeat('b',64),1024);
select pg_temp.recovery_denied(format(
  'select public.qorpera_prepare_identity_key_backup(%L,%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_login'),repeat('d',64),repeat('f',64)));
select public.qorpera_complete_native_provider_login(
  current_setting('qorpera_test.recovery_login')::uuid,repeat('d',64),'29800000-0000-4000-8000-000000000052',
  'synthetic://encrypted-capsule',repeat('e',64),'synthetic','test','recovery-fixture/v1',
  '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}');
select public.qorpera_register_identity_recovery_target('29800000-0000-4000-8000-000000000030',repeat('c',64),
  '29800000-0000-4000-8000-000000000040','29800000-0000-4000-8000-000000000020',
  '29800000-0000-4000-8000-000000000041',repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64));
reset role;

-- RECOVERY_CONCURRENCY_FIXTURE_READY
do $$
declare v_role text; v_table text;
begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    foreach v_table in array array['qorpera_identity_recovery_authorities','qorpera_identity_key_backups','qorpera_identity_recovery_targets','qorpera_identity_recoveries','qorpera_identity_backup_login_receipts'] loop
      if has_table_privilege(v_role,'public.'||v_table,'SELECT,INSERT,UPDATE,DELETE') then
        raise exception 'Direct recovery table privilege leaked to %',v_role; end if;
    end loop;
    if has_function_privilege(v_role,'public.qorpera_recovery_locked(uuid,text,uuid,text)','EXECUTE')
      or has_function_privilege(v_role,'public.qorpera_activate_identity_recovery(uuid)','EXECUTE') then
      raise exception 'Internal recovery helper exposed'; end if;
  end loop;
end
$$;

select pg_temp.recovery_claims('service_role');
set local role service_role;
select pg_temp.recovery_denied($q$update public.qorpera_member_compute_identities
  set recovery_epoch=1 where id='29800000-0000-4000-8000-000000000020'$q$);
select pg_temp.recovery_denied($q$update public.qorpera_member_compute_identities
  set recovery_pending_id=null where id='29800000-0000-4000-8000-000000000020'$q$);
select pg_temp.recovery_denied($q$insert into public.qorpera_member_compute_identities
  (id,profile_id,ownership_kind,client_identity_id,display_name,recovery_epoch)
  values('29800000-0000-4000-8000-000000000022','29800000-0000-4000-8000-000000000010',
    'company','29800000-0000-4000-8000-000000000022','Forged generation',1)$q$);
select pg_temp.assert_recovery(has_column_privilege('service_role','public.qorpera_member_compute_identities',
  'display_name','UPDATE,INSERT'),'Existing service column permissions changed');
select pg_temp.assert_recovery(not has_column_privilege('service_role','public.qorpera_member_compute_identities',
  'recovery_epoch','UPDATE,INSERT'),'Service role can alter the recovery generation');
select pg_temp.assert_recovery(not has_column_privilege('service_role','public.qorpera_member_compute_identities',
  'recovery_pending_id','UPDATE,INSERT'),'Service role can clear the recovery fence');
reset role;

select pg_temp.recovery_claims('authenticated','29800000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.recovery_denied($q$select public.qorpera_request_identity_recovery(
  '29800000-0000-4000-8000-000000000020','29800000-0000-4000-8000-000000000040',
  '29800000-0000-4000-8000-000000000060',1,repeat('b',64),'nas')$q$);
select pg_temp.recovery_claims('authenticated','29800000-0000-4000-8000-000000000004');
select pg_temp.recovery_denied($q$select public.qorpera_review_identity_recovery(
  '29800000-0000-4000-8000-000000000020','29800000-0000-4000-8000-000000000040')$q$);
select pg_temp.recovery_claims('authenticated','29800000-0000-4000-8000-000000000001');
select pg_temp.assert_recovery(public.qorpera_review_identity_recovery(
  '29800000-0000-4000-8000-000000000020','29800000-0000-4000-8000-000000000040')#>>'{target,imageSha256}'=repeat('1',64),'Review omitted exact replacement image');
select set_config('qorpera_test.recovery_request',(public.qorpera_request_identity_recovery(
  '29800000-0000-4000-8000-000000000020','29800000-0000-4000-8000-000000000040',
  '29800000-0000-4000-8000-000000000060',1,repeat('b',64),'supabase')->>'recoveryId'),true);
select pg_temp.assert_recovery(public.qorpera_request_identity_recovery(
  '29800000-0000-4000-8000-000000000020','29800000-0000-4000-8000-000000000040',
  '29800000-0000-4000-8000-000000000060',1,repeat('b',64),'supabase')->>'status'='awaiting_member','Owner bypassed another member consent');
select pg_temp.recovery_denied($q$select public.qorpera_request_identity_recovery(
  '29800000-0000-4000-8000-000000000020','29800000-0000-4000-8000-000000000040',
  '29800000-0000-4000-8000-000000000060',1,repeat('b',64),'nas')$q$);
select pg_temp.recovery_denied(format('select public.qorpera_consent_identity_recovery(%L)',current_setting('qorpera_test.recovery_request')));
select pg_temp.recovery_claims('authenticated','29800000-0000-4000-8000-000000000002');
select pg_temp.assert_recovery(public.qorpera_consent_identity_recovery(current_setting('qorpera_test.recovery_request')::uuid)->>'status'='approved','Member consent did not activate recovery');
reset role;
select pg_temp.assert_recovery((select recovery_epoch=1 and recovery_pending_id is not null from public.qorpera_member_compute_identities where id='29800000-0000-4000-8000-000000000020'),'Recovery did not fence the old generation');
select pg_temp.recovery_denied(format('update public.qorpera_native_provider_login_sessions set status=status where id=%L',current_setting('qorpera_test.recovery_login')));
select pg_temp.recovery_claims('service_role');
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_prepare_identity_key_release(%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64)));
reset role;
-- Advance only the disposable fixture's not-before clock, never authority code.
update public.qorpera_identity_recoveries set not_before=clock_timestamp()-interval '1 second'
where id=current_setting('qorpera_test.recovery_request')::uuid;

savepoint current_authority;
select pg_temp.recovery_claims('authenticated','29800000-0000-4000-8000-000000000001');
set local role authenticated;
select public.qorpera_cancel_identity_recovery(current_setting('qorpera_test.recovery_request')::uuid);
reset role;
select pg_temp.assert_recovery((select recovery_epoch=1 and recovery_pending_id is not null
  from public.qorpera_member_compute_identities where id='29800000-0000-4000-8000-000000000020'),
  'Cancellation revived the lost identity generation');
select pg_temp.recovery_claims('service_role');
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_prepare_identity_key_release(%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64)));
rollback to savepoint current_authority;
update public.qorpera_identity_recoveries set expires_at=created_at+interval '1 millisecond'
where id=current_setting('qorpera_test.recovery_request')::uuid;
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_prepare_identity_key_release(%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64)));
select pg_temp.assert_recovery((public.qorpera_identity_recovery_runtime_state(
  '29800000-0000-4000-8000-000000000020')->>'blocked')::boolean,'Expiry revived the lost identity generation');
rollback to savepoint current_authority;
-- The last founder cannot step down while others remain: a second founder joins first.
insert into auth.users(id,email) values ('29800000-0000-4000-8000-0000000000f1','recovery-cofounder@example.test');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
values ('29800000-0000-4000-8000-000000000010','29800000-0000-4000-8000-0000000000f1','recovery-cofounder@example.test','Co-founder','owner');
update public.qorpera_profile_members set role='contributor'
where profile_id='29800000-0000-4000-8000-000000000010' and user_id='29800000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_prepare_identity_key_release(%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64)));
rollback to savepoint current_authority;
update public.qorpera_member_compute_identities set policy='{"changed":true}'
where id='29800000-0000-4000-8000-000000000020';
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_prepare_identity_key_release(%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64)));
rollback to savepoint current_authority;
update public.qorpera_identity_recovery_targets set status='revoked' where id='29800000-0000-4000-8000-000000000040';
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_prepare_identity_key_release(%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64)));
rollback to savepoint current_authority;
delete from public.qorpera_profile_members where profile_id='29800000-0000-4000-8000-000000000010' and user_id='29800000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.recovery_denied(format('select public.qorpera_prepare_identity_key_release(%L,%L,%L,%L)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64)));
rollback to savepoint current_authority;
set local role service_role;
select set_config('qorpera_test.recovery_release',public.qorpera_prepare_identity_key_release(
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request')::uuid,repeat('3',64))::text,true);
select pg_temp.assert_recovery(public.qorpera_prepare_identity_key_release(
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request')::uuid,repeat('3',64))=
  current_setting('qorpera_test.recovery_release')::jsonb,'Release retry changed its authority or lifetime');
select pg_temp.assert_recovery(current_setting('qorpera_test.recovery_release')::jsonb->>'storageSource'='supabase','Restore silently changed storage source');
select public.qorpera_commit_identity_key_release('29800000-0000-4000-8000-000000000030',repeat('c',64),
  current_setting('qorpera_test.recovery_request')::uuid,repeat('3',64),repeat('4',64),1024);
select pg_temp.recovery_denied(format('select public.qorpera_commit_identity_key_release(%L,%L,%L,%L,%L,1024)',
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request'),repeat('3',64),repeat('5',64)));
select set_config('qorpera_test.recovery_receipt',public.qorpera_complete_identity_recovery(
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request')::uuid,
  repeat('3',64),repeat('4',64),repeat('5',64))::text,true);
select pg_temp.assert_recovery(public.qorpera_complete_identity_recovery(
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request')::uuid,
  repeat('3',64),repeat('4',64),repeat('5',64))=current_setting('qorpera_test.recovery_receipt')::jsonb,'Completion replay changed its receipt');
select pg_temp.assert_recovery(public.qorpera_prepare_identity_key_release(
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_request')::uuid,
  repeat('3',64))->>'status'='completed','Completed recovery released key material again');
reset role;
select pg_temp.assert_recovery((select recovery_epoch=1 and recovery_pending_id is null from public.qorpera_member_compute_identities where id='29800000-0000-4000-8000-000000000020'),'Recovery did not retain the fenced generation');
select pg_temp.assert_recovery((select count(*)=1 and not bool_or(allow_autonomous) from public.qorpera_provider_connection_versions),'Recovery changed provider consent');
select pg_temp.assert_recovery((select count(*)=0 from public.qorpera_execution_runs where profile_id='29800000-0000-4000-8000-000000000010'),'Recovery created work');
select pg_temp.assert_recovery((select count(*)=0 from public.qorpera_agent_sends),'Recovery published a message');

-- Reverting a policy creates a new revision; it never rolls back to an old
-- matching backup. Each native login has its own verified key-possession receipt.
select pg_temp.recovery_claims('authenticated','29800000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.recovery_login2',public.qorpera_begin_native_provider_login(
  '29800000-0000-4000-8000-000000000010','29800000-0000-4000-8000-000000000061',
  '29800000-0000-4000-8000-000000000062','29800000-0000-4000-8000-000000000020',
  'openai','codex-cli',repeat('d',64),3600)->>'login_id',true);
reset role;
select pg_temp.recovery_claims('service_role');
set local role service_role;
select pg_temp.recovery_denied(format(
  'select public.qorpera_complete_native_provider_login(%L,%L,%L,%L,%L,%L,%L,%L,%L::jsonb)',
  current_setting('qorpera_test.recovery_login2'),repeat('d',64),'29800000-0000-4000-8000-000000000063',
  'synthetic://unverified-capsule',repeat('e',64),'synthetic','test','recovery-fixture/v1',
  '{"monthly_microusd":1000000,"reservation_microusd":100000,"max_calls_per_run":32,"max_input_tokens_per_run":2000000,"max_output_tokens_per_run":500000,"max_concurrent_runs":1}'));
reset role;
update public.qorpera_member_compute_identities set policy='{"revised":true}'
where id='29800000-0000-4000-8000-000000000020';
set local role service_role;
select pg_temp.assert_recovery(public.qorpera_prepare_identity_key_backup(
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_login2')::uuid,
  repeat('d',64),repeat('a',64))#>>'{binding,revision}'='2','Changed policy did not advance backup revision');
select public.qorpera_complete_identity_key_backup('29800000-0000-4000-8000-000000000030',repeat('c',64),
  current_setting('qorpera_test.recovery_login2')::uuid,repeat('d',64),repeat('a',64),2,repeat('7',64),1024);
reset role;
update public.qorpera_member_compute_identities set policy='{}' where id='29800000-0000-4000-8000-000000000020';
set local role service_role;
select pg_temp.assert_recovery(public.qorpera_prepare_identity_key_backup(
  '29800000-0000-4000-8000-000000000030',repeat('c',64),current_setting('qorpera_test.recovery_login2')::uuid,
  repeat('d',64),repeat('a',64))#>>'{binding,revision}'='3','Policy reversion rolled back a backup');
reset role;
rollback;
