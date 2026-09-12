import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';

const canonical=value=>JSON.stringify(value,function(_key,next){return next&&typeof next==='object'&&!Array.isArray(next)?Object.fromEntries(Object.keys(next).sort().map(k=>[k,next[k]])):next;});
const sha=text=>createHash('sha256').update(text).digest('hex');
const hash=()=>randomBytes(32).toString('hex');
const quote=value=>`'${String(value).replaceAll("'","''")}'`;

export function enrollOriginalSoftwareFixture({predecessor,service,execute,literal}) {
 const capability=hash(),allocation=predecessor.startup.allocationId;
 const base={imageSha256:predecessor.startup.imageSha256,bootstrapSha256:predecessor.startup.bootstrapSha256,packageManifestSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40)};
 const current={packageManifestSha256:base.packageManifestSha256,sourceCommit:base.sourceCommit,
  service:{path:'/opt/qorpera-office/qorpera-company-computer-service.mjs',bytes:4096,sha256:'9'.repeat(64)}};
 // The reset fixture deliberately retains a founder pause. Temporarily remove
 // it only inside this fixture transaction to exercise actual baseline RPC;
 // restore the exact pause rows before committing, then snapshot old history.
 execute(`begin; create temporary table package_saved_pauses as select * from public.qorpera_company_execution_pauses;
  delete from public.qorpera_company_execution_pauses;
  create temporary table package_saved_provider as select * from public.qorpera_runtime_office_providers;
  update public.qorpera_runtime_office_providers set preparation_enabled=true;
  insert into public.qorpera_office_software_provider_capabilities values(${quote(allocation)},${quote(predecessor.providerId)},${quote(predecessor.providerPolicySha256)},${quote(sha(capability))},1,true);
  ${service} select public.qorpera_enroll_office_software(${literal(predecessor)},${literal(base)},${literal(current)},${quote(hash())},${quote(capability)});
  reset role; insert into public.qorpera_company_execution_pauses select * from package_saved_pauses;
  update public.qorpera_runtime_office_providers p set preparation_enabled=s.preparation_enabled from package_saved_provider s where p.office_id=s.office_id and p.computer_generation=s.computer_generation; commit;`);
}

// Provider signature, protected package and physical measurements are explicit
// fixtures. Actual SQL owns all authority, scope, revision and replay checks.
export async function officePackageSqlFixture({resetPlan,service,owner,call,execute,deny,refuse,literal,providerCapability}) {
 const allocation=resetPlan.predecessor.startup.allocationId,capability=providerCapability??hash(),capHash=sha(capability);
 const rpc=(name,args,role=service)=>call(`select public.${name}(${args.join(',')});`,role);
 const sql=(name,args)=>`select public.${name}(${args.join(',')});`;
 const snapshot=()=>execute(`select jsonb_build_object('baselines',(select jsonb_agg(b order by allocation_id) from public.qorpera_office_software_baselines b),
  'revisions',(select jsonb_agg(r order by allocation_id,revision) from public.qorpera_office_software_revisions r));`);
 const beforeSoftware=snapshot();
 const cap=call(`select to_jsonb(c) from public.qorpera_office_package_capabilities c where allocation_id=${quote(allocation)};`,'');
 if(!cap)execute(`insert into public.qorpera_office_package_capabilities values(${quote(allocation)},${quote(resetPlan.predecessor.providerId)},${quote(resetPlan.predecessor.providerPolicySha256)},${quote(capHash)},1,true);`);
 else assert.equal(cap.capability_sha256,capHash,'repeated reset keeps the same separate provider capability');
 const revision=Number(execute(`select coalesce((select current_revision from public.qorpera_office_package_baselines where allocation_id=${quote(allocation)}),0);`))+1;
 const expectedSoftwareRevision=call(`select to_jsonb(a.software_revision) from public.qorpera_runtime_office_activations a where activation_id=${quote(resetPlan.predecessor.activationId)};`,'');
 const runtimeBundle=call(`select jsonb_build_object('id',b.bundle_key,'version',b.version,'sha256',b.sha256) from public.qorpera_runtime_bundles b join public.qorpera_active_runtime_bundle a on a.runtime_bundle_id=b.id where a.singleton;`,'');
 const statement={schema:'qorpera.office-code-package-provision-statement/v1',
  base:{imageSha256:resetPlan.predecessor.startup.imageSha256,bootstrapSha256:resetPlan.predecessor.startup.bootstrapSha256,packageManifestSha256:'a'.repeat(64),sourceCommit:'b'.repeat(40)},
  target:{packageManifestSha256:'c'.repeat(64),sourceCommit:'d'.repeat(40),runtimeBundle,
   service:{path:'/opt/qorpera-office/qorpera-company-computer-service.mjs',bytes:4096,sha256:'e'.repeat(64)},
   capabilities:['reset-configuration/v1','reset-service-start/v1','reset-service-restart/v1']},
  tools:{bootstrap:{bytes:1024,sha256:'f'.repeat(64)},measure:{bytes:1024,sha256:'1'.repeat(64)}},
  compatibility:{baseInstallationReceiptSha256:'2'.repeat(64),unchangedExternalDependenciesSha256:'3'.repeat(64)},
  acceptance:{testedAt:'2026-09-12T00:00:00.000Z',evidenceSha256:'4'.repeat(64),change:'code-only-package'}};
 const plan={schema:'qorpera.lxd-office-code-package-provision-plan/v1',provisionId:randomUUID(),resetId:resetPlan.resetId,
  resetPlanSha256:sha(canonical(resetPlan)),providerBindingSha256:resetPlan.providerBindingSha256,
  rootIncarnationId:resetPlan.rootIncarnationId,successorActivationId:resetPlan.successorActivationId,
  statementSha256:sha(canonical(statement)),expectedSoftwareRevision,targetRevision:revision,installCommandId:randomUUID()};
 const planSha256=sha(canonical(plan));
 const enroll=(p=plan,s=statement,r=resetPlan,secret=capability)=>sql('qorpera_enroll_office_package_provision',
  [quote(canonical(r)),quote(canonical(p)),quote(canonical(s)),quote(sha(canonical(p))),quote(secret)]);
 for(const secret of ['0'.repeat(64),capHash])await refuse(enroll(plan,statement,resetPlan,secret),/capability unavailable/);
 await deny(enroll(),owner);
 for(const bad of [{...plan,targetRevision:revision+1},{...plan,expectedSoftwareRevision:expectedSoftwareRevision===null?0:null}])
  await refuse(enroll(bad),/current revision changed/);
 await refuse(enroll({...plan,resetPlanSha256:'0'.repeat(64)}),/document binding differs/);
 await refuse(enroll({...plan,rootIncarnationId:randomUUID()}),/document binding differs/);
 const badStatement={...statement,target:{...statement.target,runtimeBundle:{...runtimeBundle,sha256:'0'.repeat(64)}}};
 await refuse(enroll({...plan,statementSha256:sha(canonical(badStatement))},badStatement),/runtime bundle not admitted/);
 const status=call(enroll());assert.equal(status.state,'enrolled');assert.equal(status.targetRevision,revision);assert.equal(status.request,null);
 assert.deepEqual(call(enroll()),status);
 for(const name of ['capabilities','baselines','provisions','observations','installations','invocation_challenges','measurements'])
  await deny(`select * from public.qorpera_office_package_${name};`);
 for(const role of ['anon','authenticated','service_role','qorpera_secret_broker'])assert.equal(execute(`select has_function_privilege(${quote(role)},'public.qorpera_assert_office_package_reset(jsonb,text,boolean)','execute');`),'f');
 let request,receipt,receiptSha256,inventorySha256,observationId,evidenceSha256;
 const measurements=[];
 const changed=(mutation,rpc)=>`begin; reset role; ${mutation} ${service} ${rpc}`;
 const check=(r=request)=>sql('qorpera_check_office_package_provision',[quote(plan.provisionId),quote(canonical(r)),quote(capability)]);
 const observe=id=>sql('qorpera_check_office_package_provision_observation',[quote(plan.provisionId),quote(id),quote(sha(canonical(request))),quote(capability)]);
 const ack=(r=receipt,id=observationId,inventory=inventorySha256,evidence=evidenceSha256)=>sql('qorpera_ack_office_package_provision',
  [quote(plan.provisionId),quote(id),quote(canonical(r)),quote(inventory),quote(evidence),quote(capability)]);
 return {
  plan,statement,capability,status,
  async install(restore,restoreSha256){
   request={schema:'qorpera.office-code-package-provision-request/v1',plan,planSha256,bootId:restore.bootId,restoreSha256,
    challengeId:randomUUID(),targetRevision:revision,capabilityRevision:status.capabilityRevision,targetManifestSha256:statement.target.packageManifestSha256};
   for(const bad of [{...request,bootId:randomUUID()},{...request,restoreSha256:'0'.repeat(64)},{...request,capabilityRevision:status.capabilityRevision+1}])
    await refuse(check(bad),/request binding differs/);
   for(const mutation of [
    `update public.qorpera_office_package_capabilities set enabled=false,revision=revision+1;`,
    `update public.qorpera_runtime_offices set privacy_version=privacy_version+1;`,
    `update public.qorpera_runtime_offices set revision=revision+1;`,
    `delete from public.qorpera_active_runtime_bundle;`,
    `insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${resetPlan.predecessor.startup.scope.companyId}','30000000-0000-4000-8000-000000000001');`,
   ])await deny(changed(mutation,check()));
   const authorized=call(check());assert(authorized.validForMs>0&&authorized.validForMs<=5000);
   assert.equal(authorized.requestSha256,sha(canonical(request)));assert.deepEqual(authorized.request,request);
   assert(call(check()).validForMs<=authorized.validForMs);
   await refuse(check({...request,challengeId:randomUUID()}),/dispatch identity cannot be replaced/);
   execute(`update public.qorpera_office_package_provisions set dispatch_issued_at=dispatch_issued_at-interval '6 seconds',dispatch_expires_at=dispatch_expires_at-interval '6 seconds' where id=${quote(plan.provisionId)};`);
   await refuse(check(),/dispatch challenge expired/);
   await refuse(check({...request,challengeId:randomUUID()}),/dispatch identity cannot be replaced/);
   inventorySha256=hash();evidenceSha256=hash();
   receipt={schema:'qorpera.office-code-package-provision-receipt/v1',planSha256,provisionId:plan.provisionId,resetId:plan.resetId,
    rootIncarnationId:plan.rootIncarnationId,bootId:restore.bootId,commandId:plan.installCommandId,requestSha256:sha(canonical(request)),restoreSha256,
    state:'installed',targetRevision:revision,packageManifestSha256:statement.target.packageManifestSha256,installedInventorySha256:inventorySha256,
    sourceCommit:statement.target.sourceCommit,runtimeBundle:statement.target.runtimeBundle,service:statement.target.service};
   receiptSha256=sha(canonical(receipt));observationId=randomUUID();
   await refuse(ack(),/observation challenge absent/);
   const expiredObservation=randomUUID();call(observe(expiredObservation));
   execute(`update public.qorpera_office_package_observations set issued_at=issued_at-interval '6 seconds',expires_at=expires_at-interval '6 seconds' where id=${quote(expiredObservation)};`);
   await refuse(ack(receipt,expiredObservation),/observation challenge expired/);
   await refuse(observe(expiredObservation),/observation challenge expired/);
   const observation=call(observe(observationId));assert(observation.validForMs>0&&observation.validForMs<=5000);
   for(const bad of [{...receipt,bootId:randomUUID()},{...receipt,rootIncarnationId:randomUUID()},{...receipt,commandId:randomUUID()},
    {...receipt,targetRevision:revision+1},{...receipt,packageManifestSha256:'0'.repeat(64)},{...receipt,runtimeBundle:{...runtimeBundle,sha256:'0'.repeat(64)}}])
    await refuse(ack(bad),/measured installation differs/);
   await refuse(ack(receipt,observationId,hash()),/measured installation differs/);
   // Independent observation is fresh even after original dispatch expires.
   const installed=call(ack());assert.equal(installed.state,'installed');assert.equal(installed.currentPackageRevision,revision);
   assert.equal(installed.receiptSha256,receiptSha256);assert.deepEqual(call(ack()),installed);
   await refuse(ack(receipt,observationId,inventorySha256,hash()),/installation cannot be rebound/);
   await refuse(check(),/already acknowledged/);
   assert.equal(snapshot(),beforeSoftware,'package installation must not rewrite service-only history');
   console.log('PASS: package provision exact-text identity, preimage-only capability, immutable dispatch expiry, fresh observation recovery and measured install custody');
  },
  async measure(startup,activationId,activateSql){
   await refuse(activateSql,/package activation measurement unavailable/);
   const nonce=randomUUID(),measureHash=hash();
   const checkSql=sql('qorpera_check_office_package_invocation',[literal(startup),quote(activationId),quote(nonce),quote(capability)]);
   const challenge=call(checkSql);assert.equal(challenge.receiptSha256,receiptSha256);assert.equal(challenge.installedInventorySha256,inventorySha256);
   assert.deepEqual(challenge.runtimeBundle,runtimeBundle);
   const measure=(serviceValue=statement.target.service,bundleValue=runtimeBundle,inventory=inventorySha256)=>sql('qorpera_ack_office_package_invocation',
    [literal(startup),quote(activationId),quote(nonce),quote(receiptSha256),quote(inventory),literal(serviceValue),literal(bundleValue),quote(measureHash),quote(capability)]);
   await refuse(measure({...statement.target.service,sha256:hash()}),/measured bytes differ/);
   await refuse(measure(statement.target.service,{...runtimeBundle,sha256:hash()}),/measured bytes differ/);
   await refuse(measure(statement.target.service,runtimeBundle,hash()),/measured bytes differ/);
   const measured=call(measure());assert.equal(measured.state,'measured');assert.equal(measured.provisionId,plan.provisionId);
   measurements.push({sql:measure(),measured});
   // Keep auxiliary Docker roundtrips out of the bounded acknowledgement-to-
   // activation path. Both assertions remain mandatory after activation.
   return () => {
    assert.deepEqual(call(measure()),measured);
    assert.equal(execute(`select software_revision is null and package_provision_id=${quote(plan.provisionId)} from public.qorpera_runtime_office_activations where activation_id=${quote(activationId)};`),'t');
   };
  },
  replay(){const result=call(ack());assert.deepEqual(call(enroll()),result);assert.equal(result.state,'installed');assert.equal(result.receiptSha256,receiptSha256);for(const saved of measurements)assert.deepEqual(call(saved.sql),saved.measured);},
 };
}
