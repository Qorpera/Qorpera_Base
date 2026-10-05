begin;
create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',message; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
 begin execute statement; exception when insufficient_privilege or invalid_parameter_value or serialization_failure or unique_violation or object_not_in_prerequisite_state then return; end;
 raise exception 'Accepted forbidden node update: %',statement;
end $$;
insert into auth.users(id,email) values('32100000-0000-4000-8000-000000000001','node-updater@example.test');
insert into public.qorpera_profiles(id,name,created_by_user_id) values('32100000-0000-4000-8000-000000000010','Node update fixture','32100000-0000-4000-8000-000000000001');
insert into public.qorpera_profile_members(profile_id,user_id,email,display_name,role)
 values('32100000-0000-4000-8000-000000000010','32100000-0000-4000-8000-000000000001','node-updater@example.test','Owner','owner');
-- A folder-v2 company (the company folder core).
insert into public.qorpera_company_environments(id,profile_id,name,contract_version,created_by_user_id)
 values('32100000-0000-4000-8000-000000000011','32100000-0000-4000-8000-000000000010','Node update fixture',1,'32100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.qorpera_folder_enable('32100000-0000-4000-8000-000000000011') \g /dev/null
select pg_temp.ok(public.qorpera_company_is_folder_v2('32100000-0000-4000-8000-000000000010'),'Node update company is not a folder-v2 company');
set local role service_role;
select public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1','nodeId','32100000-0000-4000-8000-000000000020',
 'machineIdSha256',repeat('a',64),'label','node-update-fixture','cpuMillis',16000,'memoryBytes',68719476736,'headroomCpuMillis',4000,'headroomMemoryBytes',17179869184,
 'standardCpuMillis',4000,'standardMemoryBytes',8589934592,'enabled',true),0);
-- Forged JWT operator claims cannot grant a service connection enrollment rights.
select set_config('request.jwt.claims','{"role":"postgres"}',true);
select pg_temp.denied($q$select public.qorpera_enroll_node_updater('32100000-0000-4000-8000-000000000020',repeat('0',64),0,true,4,repeat('b',64),repeat('c',64))$q$);
reset role;
-- Exercise the function's real role guard independently of its normal ACL.
grant execute on function public.qorpera_node_update_operator() to service_role;
set local role service_role;
select pg_temp.denied('select public.qorpera_node_update_operator()');
reset role;
revoke execute on function public.qorpera_node_update_operator() from service_role;
select public.qorpera_enroll_node_updater('32100000-0000-4000-8000-000000000020',encode(extensions.digest(repeat('9',64),'sha256'),'hex'),0,true,4,repeat('b',64),repeat('c',64));
select set_config('t.node_cap',repeat('9',64),true);
select set_config('t.node_cap_revision','1',true);
select set_config('t.node_release',public.qorpera_node_update_canonical(jsonb_build_object(
 'schema','qorpera.runtime-node-update-release/v1','nodeId','32100000-0000-4000-8000-000000000020','machineIdSha256',repeat('a',64),'revision',5,
 'previous',jsonb_build_object('revision',4,'releaseSha256',repeat('b',64),'artifactSha256',repeat('c',64)),
 'artifact',jsonb_build_object('bytes',12345,'sha256',repeat('d',64)),'runtimeBundleSha256',(select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle),
 'sourceCommit',repeat('f',40),'acceptanceEvidenceSha256',repeat('1',64))),true);
select set_config('t.node_release_sha',encode(extensions.digest(current_setting('t.node_release'),'sha256'),'hex'),true);
-- Signature bytes are deliberately a shape-only DB fixture. TS verifies real Ed25519.
select public.qorpera_publish_node_update(current_setting('t.node_release'),repeat('A',86)||'==',array['32100000-0000-4000-8000-000000000010'::uuid],repeat('2',64));
select pg_temp.denied(format('select public.qorpera_publish_node_update(%L,%L,%L,%L)',current_setting('t.node_release'),repeat('A',86)||'==','{32100000-0000-4000-8000-000000000010}',repeat('2',64)));
select pg_temp.denied(format('select public.qorpera_authorize_node_update_drain(%L,%L,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_release_sha'),repeat('3',64)));

-- All table access and all helper/operator RPCs stay private even to service_role.
do $$ declare role_name text; object_name text; begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
  foreach object_name in array array['qorpera_node_update_enrollments','qorpera_node_update_targets','qorpera_node_update_phase_intents','qorpera_node_update_phase_receipts'] loop
   perform pg_temp.ok(not has_table_privilege(role_name,'public.'||object_name,'SELECT,INSERT,UPDATE,DELETE'),'Node update table leaked');
  end loop;
  perform pg_temp.ok(not has_function_privilege(role_name,'public.qorpera_node_update_locked(uuid,bigint,text,text)','EXECUTE'),'Internal capability guard leaked');
  perform pg_temp.ok(not has_function_privilege(role_name,'public.qorpera_release_node_update_admission(uuid,text,bigint,text)','EXECUTE'),'Coordinator authority leaked');
 end loop;
end $$;

-- The helper builds fake physical receipts only; RPCs still enforce actual node
-- authority, pause and admission CAS in this isolated DB.
create function pg_temp.node_state() returns jsonb language sql as $$
 select public.qorpera_read_node_update('32100000-0000-4000-8000-000000000020',current_setting('t.node_cap_revision')::bigint,current_setting('t.node_cap'),current_setting('t.node_release_sha'))
$$;
create function pg_temp.prepare(p_phase text,p_bad_observation jsonb default null) returns jsonb language plpgsql security definer as $$
declare s jsonb; i jsonb; o jsonb; previous_sha text;
begin
 s:=pg_temp.node_state(); o:=s->'observation';
 if jsonb_array_length(s->'receipts')>0 then previous_sha:=public.qorpera_node_update_sha(s#>array['receipts',(jsonb_array_length(s->'receipts')-1)::text,'receipt']); end if;
 i:=jsonb_build_object('schema','qorpera.runtime-node-update-intent/v1','releaseSha256',current_setting('t.node_release_sha'),'phase',p_phase,'previousReceiptSha256',previous_sha,'observation',o);
 if p_bad_observation is not null then i:=jsonb_set(i,'{observation}',o||p_bad_observation); end if;
 perform public.qorpera_prepare_node_update_phase('32100000-0000-4000-8000-000000000020',current_setting('t.node_cap_revision')::bigint,current_setting('t.node_cap'),current_setting('t.node_release_sha'),public.qorpera_node_update_canonical(i));
 perform set_config('t.phase_intent',public.qorpera_node_update_canonical(i),true);
 return i;
end $$;
create function pg_temp.phase(p_phase text,p_state text default 'succeeded',p_bad_observation jsonb default null,p_bad_drain jsonb default null) returns jsonb language plpgsql security definer as $$
declare s jsonb; i jsonb; r jsonb;
begin
 s:=pg_temp.node_state();
 select x into i from jsonb_array_elements(s->'intents') x where x->>'phase'=p_phase;
 if i is null or p_bad_observation is not null then i:=pg_temp.prepare(p_phase,p_bad_observation); end if;
 r:=jsonb_build_object('schema','qorpera.runtime-node-update-receipt/v1','intentSha256',public.qorpera_node_update_sha(i),'state',p_state,'evidenceSha256',repeat('4',64),'drain',s->'drain');
 if p_bad_drain is not null then r:=jsonb_set(r,'{drain}',(s->'drain')||p_bad_drain); end if;
 perform set_config('t.phase_intent',public.qorpera_node_update_canonical(i),true);
 perform set_config('t.phase_receipt',public.qorpera_node_update_canonical(r),true);
 return public.qorpera_record_node_update_phase('32100000-0000-4000-8000-000000000020',current_setting('t.node_cap_revision')::bigint,current_setting('t.node_cap'),current_setting('t.node_release_sha'),current_setting('t.phase_intent'),current_setting('t.phase_receipt'));
end $$;

set local role anon;
select pg_temp.ok((public.qorpera_desired_node_update('32100000-0000-4000-8000-000000000020',1,current_setting('t.node_cap'))->'envelope'->'release'->>'revision')='5','Scoped discovery missed release');
select pg_temp.denied(format('select public.qorpera_read_node_update(%L,1,%L,%L)','32100000-0000-4000-8000-000000000021',current_setting('t.node_cap'),current_setting('t.node_release_sha')));
select pg_temp.denied(format('select public.qorpera_read_node_update(%L,1,%L,%L)','32100000-0000-4000-8000-000000000020',repeat('8',64),current_setting('t.node_release_sha')));
select pg_temp.denied(format('select public.qorpera_read_node_update(%L,2,%L,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha')));
select pg_temp.phase('stage');
-- Exact immutable receipt replay succeeds; a conflicting evidence digest does not.
select public.qorpera_record_node_update_phase('32100000-0000-4000-8000-000000000020',1,current_setting('t.node_cap'),current_setting('t.node_release_sha'),current_setting('t.phase_intent'),current_setting('t.phase_receipt'));
select pg_temp.denied(format('select public.qorpera_record_node_update_phase(%L,1,%L,%L,%L,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha'),current_setting('t.phase_intent'),replace(current_setting('t.phase_receipt'),repeat('4',64),repeat('5',64))));
select pg_temp.denied('select pg_temp.phase(''install'')');
select pg_temp.denied(format('select public.qorpera_drain_node_update(%L,1,%L,%L,1,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha'),pg_temp.node_state()#>>'{observation,policySha256}'));
reset role;
-- The pause is an operator brake, in a founder's name. A folder-v2 company refuses the snapshot-v1 founder pause
-- (qorpera_set_company_execution_pause, 0A000); the operator pauses it through the folder core, as 849 does.
select public.qorpera_folder_pause('32100000-0000-4000-8000-000000000010','32100000-0000-4000-8000-000000000001','node update fixture') \g /dev/null
select set_config('request.jwt.claims','{"role":"authenticated","sub":"32100000-0000-4000-8000-000000000001"}',true);
select public.qorpera_authorize_node_update_drain('32100000-0000-4000-8000-000000000020',current_setting('t.node_release_sha'),repeat('3',64));
set local role anon;
select set_config('t.before_transition',(pg_temp.node_state()->'observation')::text,true);
select pg_temp.prepare('drain');
-- A confirmed pre-effect failure is terminal and does not manufacture a drain.
savepoint failed_drain;
select pg_temp.phase('drain','failed');
select pg_temp.ok(pg_temp.node_state()->'drain'='null'::jsonb,'Failed drain invented policy ownership');
select pg_temp.denied('select pg_temp.prepare(''stop'')');
select pg_temp.denied(format('select public.qorpera_drain_node_update(%L,1,%L,%L,1,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha'),pg_temp.node_state()#>>'{observation,policySha256}'));
rollback to failed_drain;
select pg_temp.denied(format('select public.qorpera_drain_node_update(%L,1,%L,%L,2,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha'),pg_temp.node_state()#>>'{observation,policySha256}'));
select public.qorpera_drain_node_update('32100000-0000-4000-8000-000000000020',1,current_setting('t.node_cap'),current_setting('t.node_release_sha'),1,pg_temp.node_state()#>>'{observation,policySha256}');
select pg_temp.phase('drain');
select pg_temp.ok((pg_temp.node_state()#>>'{observation,enabled}')='false','Drain did not disable');
select pg_temp.prepare('stop');
select set_config('t.stop_intent_sha',encode(extensions.digest(current_setting('t.phase_intent'),'sha256'),'hex'),true);
select public.qorpera_check_node_update('32100000-0000-4000-8000-000000000020',1,current_setting('t.node_cap'),current_setting('t.node_release_sha'),current_setting('t.stop_intent_sha'));
reset role;

-- Revocation rejects polling as well as writes; rotation preserves baseline.
select public.qorpera_enroll_node_updater('32100000-0000-4000-8000-000000000020',encode(extensions.digest(repeat('9',64),'sha256'),'hex'),1,false,4,repeat('b',64),repeat('c',64));
set local role anon;
select pg_temp.denied('select pg_temp.node_state()');
reset role;
select public.qorpera_enroll_node_updater('32100000-0000-4000-8000-000000000020',encode(extensions.digest(repeat('9',64),'sha256'),'hex'),2,true,4,repeat('b',64),repeat('c',64));
select set_config('t.node_cap_revision','3',true);

-- A disappeared/recreated pause is different authority. No updater resumes it.
create temporary table old_pause as select * from public.qorpera_company_execution_pauses where profile_id='32100000-0000-4000-8000-000000000010';
delete from public.qorpera_company_execution_pauses where profile_id='32100000-0000-4000-8000-000000000010';
set local role anon;
select pg_temp.denied(format('select public.qorpera_check_node_update(%L,3,%L,%L,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha'),current_setting('t.stop_intent_sha')));
reset role;
insert into public.qorpera_company_execution_pauses select * from old_pause;
set local role anon;
select pg_temp.denied($q$select pg_temp.phase('stop','succeeded','{"enabled":true}')$q$);
select pg_temp.denied($q$select pg_temp.phase('stop','succeeded','{"policyVersion":1}')$q$);
select pg_temp.denied($q$select pg_temp.phase('stop','succeeded',jsonb_build_object('activeRuntimeBundleSha256',repeat('0',64)))$q$);
select pg_temp.denied($q$select pg_temp.phase('stop','succeeded',jsonb_build_object('admissionReleaseSha256',repeat('0',64)))$q$);
select pg_temp.denied($q$select pg_temp.phase('stop','succeeded','{"extra":"untrusted"}')$q$);
select pg_temp.denied($q$select pg_temp.phase('stop','succeeded',null,jsonb_build_object('policySha256',repeat('0',64)))$q$);
select pg_temp.denied($q$select pg_temp.phase('stop','succeeded',null,'{"extra":"untrusted"}')$q$);
-- A bundle transition between physical effect and publication does not change
-- the retained intent. This scratch-only savepoint restores the active bundle.
reset role;
savepoint bundle_transition;
update public.qorpera_active_runtime_bundle a set runtime_bundle_id=b.id,runtime_bundle_sha256=b.sha256
 from (select id,sha256 from public.qorpera_runtime_bundles where sha256<>(select runtime_bundle_sha256 from public.qorpera_active_runtime_bundle) order by version limit 1) b;
select pg_temp.ok((select runtime_bundle_sha256<>current_setting('t.node_release')::jsonb->>'runtimeBundleSha256' from public.qorpera_active_runtime_bundle),'Fixture did not change bundle');
set local role anon;
select pg_temp.phase('stop');
-- Simulated lost publication reply: read proves the exact immutable receipt;
-- no stop or record RPC is repeated to learn whether it committed.
select pg_temp.ok((pg_temp.node_state()#>'{receipts,2,intent}')=current_setting('t.phase_intent')::jsonb,'Lost reply could not reconcile retained intent');
rollback to bundle_transition;
set local role anon;
select pg_temp.phase('stop');
select pg_temp.phase('install');
select pg_temp.phase('start');
select pg_temp.phase('verify');
select pg_temp.prepare('acknowledge');
reset role;
-- The coordinator cannot grant admission while the acknowledgement is pending.
select pg_temp.denied(format('select public.qorpera_release_node_update_admission(%L,%L,3,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_release_sha'),repeat('6',64)));
set local role anon;
select pg_temp.phase('acknowledge');
select pg_temp.denied(format('select public.qorpera_resume_node_update(%L,3,%L,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha')));
reset role;
select pg_temp.ok((select enabled=false and version=2 from public.qorpera_runtime_nodes where id='32100000-0000-4000-8000-000000000020'),'Installed is not admission authority');
select public.qorpera_release_node_update_admission('32100000-0000-4000-8000-000000000020',current_setting('t.node_release_sha'),3,repeat('6',64));

-- Intervening operator CAS invalidates the update's restore, even if disabled.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
-- Use the genuine operator's public policy RPC with fixture-supplied exact policy.
select set_config('t.disabled_policy',(select disabled_policy::text from public.qorpera_node_update_targets where node_id='32100000-0000-4000-8000-000000000020'),true);
savepoint operator_change2;
set local role service_role;
select public.qorpera_configure_runtime_node(current_setting('t.disabled_policy')::jsonb,2);
set local role anon;
select pg_temp.denied(format('select public.qorpera_resume_node_update(%L,3,%L,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha')));
rollback to operator_change2;
set local role anon;
select set_config('t.before_transition',(pg_temp.node_state()->'observation')::text,true);
select pg_temp.prepare('resume');
select public.qorpera_resume_node_update('32100000-0000-4000-8000-000000000020',3,current_setting('t.node_cap'),current_setting('t.node_release_sha'));
reset role;
select set_config('t.next_release',public.qorpera_node_update_canonical(current_setting('t.node_release')::jsonb||jsonb_build_object('revision',6,'previous',jsonb_build_object('revision',5,'releaseSha256',current_setting('t.node_release_sha'),'artifactSha256',repeat('d',64)),'artifact',jsonb_build_object('bytes',12346,'sha256',repeat('e',64)))),true);
-- Resume committed, but phase8 is not published: no successor may supersede it.
select pg_temp.denied(format('select public.qorpera_publish_node_update(%L,%L,%L,%L)',current_setting('t.next_release'),repeat('A',86)||'==','{32100000-0000-4000-8000-000000000010}',repeat('2',64)));
set local role anon;
select pg_temp.phase('resume');
reset role;
select pg_temp.ok((select p1.policy=p3.policy from public.qorpera_runtime_node_policies p1 join public.qorpera_runtime_node_policies p3 using(node_id) where p1.node_id='32100000-0000-4000-8000-000000000020' and p1.version=1 and p3.version=3),'Original complete policy not restored');
select pg_temp.ok((select count(*)=8 from public.qorpera_node_update_phase_receipts where node_id='32100000-0000-4000-8000-000000000020'),'Phase history incomplete');
select public.qorpera_publish_node_update(current_setting('t.next_release'),repeat('A',86)||'==',array['32100000-0000-4000-8000-000000000010'::uuid],repeat('2',64));
set local role anon;
-- Publication's reply may have been lost before the local completion seal.
-- Historical exact receipt reads/replay survive an already published successor.
select pg_temp.ok(jsonb_array_length(pg_temp.node_state()->'receipts')=8,'Successor hid the retained predecessor publication');
select public.qorpera_record_node_update_phase('32100000-0000-4000-8000-000000000020',3,current_setting('t.node_cap'),current_setting('t.node_release_sha'),current_setting('t.phase_intent'),current_setting('t.phase_receipt'));
select pg_temp.denied(format('select public.qorpera_resume_node_update(%L,3,%L,%L)','32100000-0000-4000-8000-000000000020',current_setting('t.node_cap'),current_setting('t.node_release_sha')));
select pg_temp.ok((public.qorpera_desired_node_update('32100000-0000-4000-8000-000000000020',3,current_setting('t.node_cap'))#>>'{envelope,release,revision}')='6','Successor discovery differs');
reset role;
select 'NODE_UPDATE_AUTHORITY_OK' as result;
rollback;
