begin;

create function pg_temp.review_claims(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_user)::text,true)::text::void
$$;
create function pg_temp.assert_review(p_value boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_value is distinct from true then raise exception '%',p_message; end if;
end
$$;
create function pg_temp.review_denied(p_statement text)
returns void language plpgsql as $$
begin
  begin execute p_statement;
  exception when insufficient_privilege or sqlstate 'PT412' or invalid_parameter_value then return;
  end;
  raise exception 'Recovery review accepted unauthorized, stale or malformed intent';
end
$$;
create function pg_temp.review_target(p_target uuid default '29900000-0000-4000-8000-000000000030')
returns jsonb language sql as $$
  select public.qorpera_review_member_identity_recovery(
    '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000020',p_target)
$$;

insert into auth.users(id,email) values
  ('29900000-0000-4000-8000-000000000001','review-owner@example.test'),
  ('29900000-0000-4000-8000-000000000002','review-member@example.test'),
  ('29900000-0000-4000-8000-000000000003','review-admin@example.test'),
  ('29900000-0000-4000-8000-000000000004','review-outsider@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id)
values ('29900000-0000-4000-8000-000000000010','Review fixture','29900000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role) values
  ('29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000001','review-owner@example.test','Owner','owner'),
  ('29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000002','review-member@example.test','Member','contributor'),
  ('29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000003','review-admin@example.test','Admin','admin');
insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,owner_user_id,client_identity_id,display_name)
values
  ('29900000-0000-4000-8000-000000000020','29900000-0000-4000-8000-000000000010','member','29900000-0000-4000-8000-000000000002','29900000-0000-4000-8000-000000000020','Member identity'),
  ('29900000-0000-4000-8000-000000000021','29900000-0000-4000-8000-000000000010','company',null,'29900000-0000-4000-8000-000000000021','Company identity');
insert into public.qorpera_identity_recovery_authorities(id,profile_id,signing_public_key,wrapping_public_key,service_origin,capability_sha256)
values ('29900000-0000-4000-8000-000000000050','29900000-0000-4000-8000-000000000010',repeat('A',59),repeat('A',550),'https://recovery.example.test',repeat('c',64));

select pg_temp.review_claims('29900000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('qorpera_test.review_login',public.qorpera_begin_native_provider_login(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000070',
  '29900000-0000-4000-8000-000000000071','29900000-0000-4000-8000-000000000020',
  'openai','codex-cli',repeat('d',64),3600)->>'login_id',true);
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
select public.qorpera_prepare_identity_key_backup('29900000-0000-4000-8000-000000000050',repeat('c',64),
  current_setting('qorpera_test.review_login')::uuid,repeat('d',64),repeat('a',64));
select public.qorpera_complete_identity_key_backup('29900000-0000-4000-8000-000000000050',repeat('c',64),
  current_setting('qorpera_test.review_login')::uuid,repeat('d',64),repeat('a',64),1,repeat('b',64),1024);
select public.qorpera_register_identity_recovery_target('29900000-0000-4000-8000-000000000050',repeat('c',64),
  '29900000-0000-4000-8000-000000000030','29900000-0000-4000-8000-000000000020',
  '29900000-0000-4000-8000-000000000040',repeat('1',64),repeat('2',64),repeat('A',550),repeat('3',64));
select public.qorpera_register_identity_recovery_target('29900000-0000-4000-8000-000000000050',repeat('c',64),
  '29900000-0000-4000-8000-000000000031','29900000-0000-4000-8000-000000000020',
  '29900000-0000-4000-8000-000000000041',repeat('1',64),repeat('2',64),repeat('A',550),repeat('4',64));
reset role;

do $$
declare v_role text; v_signature text;
begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(v_role,'public.qorpera_recovery_member_role(uuid)','EXECUTE') then
      raise exception 'Private recovery helper is exposed'; end if;
    foreach v_signature in array array[
      'public.qorpera_list_member_recovery_identities(uuid,uuid,integer)',
      'public.qorpera_list_member_recovery_targets(uuid,uuid,uuid,integer)',
      'public.qorpera_review_member_identity_recovery(uuid,uuid,uuid)',
      'public.qorpera_decide_member_identity_recovery(uuid,uuid,uuid,text,text,uuid,text)'
    ] loop
      if has_function_privilege(v_role,v_signature,'EXECUTE') is distinct from (v_role='authenticated') then
        raise exception 'Recovery review privilege differs from member-only contract'; end if;
    end loop;
  end loop;
end
$$;

select pg_temp.review_claims('29900000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.review_denied($q$select public.qorpera_list_member_recovery_identities('29900000-0000-4000-8000-000000000010')$q$);
select pg_temp.review_claims('29900000-0000-4000-8000-000000000003');
select pg_temp.assert_review(jsonb_array_length(public.qorpera_list_member_recovery_identities(
  '29900000-0000-4000-8000-000000000010')->'items')=0,'Admin discovered another member identity');
select pg_temp.review_denied($q$select pg_temp.review_target()$q$);
select pg_temp.review_claims('29900000-0000-4000-8000-000000000002');
select pg_temp.assert_review(jsonb_array_length(public.qorpera_list_member_recovery_identities(
  '29900000-0000-4000-8000-000000000010')->'items')=1,'Member did not receive only their identity');
select pg_temp.assert_review(not (pg_temp.review_target()#>>'{review,canRequest}')::boolean,'Member could initiate owner recovery');
select pg_temp.review_denied($q$select public.qorpera_list_member_recovery_targets(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000021')$q$);

select pg_temp.review_claims('29900000-0000-4000-8000-000000000001');
select pg_temp.assert_review(jsonb_array_length(public.qorpera_list_member_recovery_identities(
  '29900000-0000-4000-8000-000000000010')->'items')=2,'Owner could not inspect company identities');
select pg_temp.assert_review((pg_temp.review_target()#>>'{review,canRequest}')::boolean,'Valid owner review cannot request');
select pg_temp.assert_review((pg_temp.review_target()#>>'{review,target,recipientKeySha256}')=
  encode(extensions.digest(decode(repeat('A',550)||'==','base64'),'sha256'),'hex'),'Exact recipient omitted');
select pg_temp.assert_review(not ((pg_temp.review_target()->'review'->'target') ? 'recipientPublicKey'),'Raw recipient key leaked');
select pg_temp.assert_review(not ((pg_temp.review_target()->'review'->'backup') ? 'encryptedMasterKey'),'Backup material leaked');
select pg_temp.review_denied($q$select public.qorpera_list_member_recovery_identities(
  '29900000-0000-4000-8000-000000000010',null,26)$q$);
select pg_temp.review_denied($q$select public.qorpera_list_member_recovery_targets(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000020',null,null)$q$);
select pg_temp.review_denied($q$select public.qorpera_review_member_identity_recovery(
  '29900000-0000-4000-8000-000000000011','29900000-0000-4000-8000-000000000020','29900000-0000-4000-8000-000000000030')$q$);
select set_config('qorpera_test.review_digest',pg_temp.review_target()->>'reviewSha256',true);
reset role;
update public.qorpera_member_compute_identities set display_name='Renamed identity' where id='29900000-0000-4000-8000-000000000020';
set local role authenticated;
select pg_temp.review_denied(format($q$select public.qorpera_decide_member_identity_recovery(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000020',
  '29900000-0000-4000-8000-000000000030',%L,'request','29900000-0000-4000-8000-000000000080','nas')$q$,
  current_setting('qorpera_test.review_digest')));
select set_config('qorpera_test.review_digest',pg_temp.review_target()->>'reviewSha256',true);
select set_config('qorpera_test.review_receipt',public.qorpera_decide_member_identity_recovery(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000020',
  '29900000-0000-4000-8000-000000000030',current_setting('qorpera_test.review_digest'),'request',
  '29900000-0000-4000-8000-000000000080','nas')::text,true);
select pg_temp.assert_review(current_setting('qorpera_test.review_receipt')::jsonb->>'status'='awaiting_member','Owner bypassed personal consent');
select pg_temp.assert_review(not (pg_temp.review_target()#>>'{review,canConsent}')::boolean,'Owner consented for another person');
-- A repeated click with the old review is not a second request, even with a new client id.
select pg_temp.review_denied(format($q$select public.qorpera_decide_member_identity_recovery(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000020',
  '29900000-0000-4000-8000-000000000030',%L,'request','29900000-0000-4000-8000-000000000081','nas')$q$,
  current_setting('qorpera_test.review_digest')));
select pg_temp.review_claims('29900000-0000-4000-8000-000000000002');
select pg_temp.assert_review((pg_temp.review_target()#>>'{review,canConsent}')::boolean,'Credential owner cannot consent');
select pg_temp.assert_review(pg_temp.review_target()#>>'{review,backup,revision}'='1','Consent substituted backup revision');
select pg_temp.assert_review(public.qorpera_decide_member_identity_recovery(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000020',
  '29900000-0000-4000-8000-000000000030',pg_temp.review_target()->>'reviewSha256','consent')->>'status'='approved',
  'Exact member consent did not activate recovery');
select pg_temp.assert_review((pg_temp.review_target()#>>'{review,identity,blocked}')::boolean,'Approval omitted execution fence');
select pg_temp.assert_review(public.qorpera_decide_member_identity_recovery(
  '29900000-0000-4000-8000-000000000010','29900000-0000-4000-8000-000000000020',
  '29900000-0000-4000-8000-000000000030',pg_temp.review_target()->>'reviewSha256','cancel')->>'status'='cancelled',
  'Credential owner cannot cancel');
select pg_temp.assert_review((pg_temp.review_target()#>>'{review,identity,blocked}')::boolean,'Cancellation revived old node');
select pg_temp.review_claims('29900000-0000-4000-8000-000000000001');
select pg_temp.assert_review((pg_temp.review_target('29900000-0000-4000-8000-000000000031')#>>'{review,canRequest}')::boolean,
  'Cancelled recovery permanently blocked a newly registered replacement');
reset role;
select pg_temp.assert_review((select count(*)=1 from public.qorpera_identity_recoveries
  where profile_id='29900000-0000-4000-8000-000000000010'),'Review/duplicate click created another recovery');
select pg_temp.assert_review((select count(*)=0 from public.qorpera_execution_runs
  where profile_id='29900000-0000-4000-8000-000000000010'),'Recovery review created work');
select pg_temp.assert_review((select count(*)=0 from public.qorpera_agent_sends),'Recovery review published a message');

-- Discovery is bounded and uses stable identity pagination, not offset scans.
insert into public.qorpera_member_compute_identities(id,profile_id,ownership_kind,client_identity_id,display_name)
select ('29900000-0000-4000-8000-'||lpad((100+ordinal)::text,12,'0'))::uuid,
  '29900000-0000-4000-8000-000000000010','company',
  ('29900000-0000-4000-8000-'||lpad((100+ordinal)::text,12,'0'))::uuid,'Paged identity '||ordinal
from generate_series(1,26) ordinal;
set local role authenticated;
select set_config('qorpera_test.review_page',public.qorpera_list_member_recovery_identities(
  '29900000-0000-4000-8000-000000000010')::text,true);
select pg_temp.assert_review(jsonb_array_length(current_setting('qorpera_test.review_page')::jsonb->'items')=25,
  'Identity discovery exceeded its page bound');
select pg_temp.assert_review(jsonb_array_length(public.qorpera_list_member_recovery_identities(
  '29900000-0000-4000-8000-000000000010',(current_setting('qorpera_test.review_page')::jsonb->>'nextAfter')::uuid)->'items')=3,
  'Identity cursor repeated or skipped rows');
reset role;
rollback;
