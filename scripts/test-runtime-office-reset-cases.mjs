import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const officeDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const PHASES=['fenced','stopped','custodied','powered_off','root_deleted','root_created','restored','prepared','active'];

/** Real SQL reset authority over a real stopped office. Every physical
 * observation (archive, VM stop/delete/create/start, root readback) is a
 * synthetic digest here; the provider worker tests own the physical side. */
export async function testOfficeResetChain({stop,attestation,scope,binding,service,owner,race,session,until,literal,execute,restartDatabase,
 controls,CompanyComputerStartupControl}){
 const predecessor=stop.request.revocation.request;
 assert.equal(predecessor.action,'replace');
 const call=(sql,role=service)=>{const output=execute(`${role} ${sql}`).split('\n').at(-1);return output?JSON.parse(output):null;};
 const deny=async(sql,role=service)=>{const [r]=await race([`${role} ${sql}`]);assert.notEqual(r.code,0,'Unexpected reset admission');assert.doesNotMatch(r.error,/does not exist|violates check constraint|syntax error/);return r;};
 const refuse=async(sql,pattern,role=service)=>{const r=await deny(sql,role);assert.match(r.error,pattern);return r;};
 const row=call(`select jsonb_build_object('intentId',intent_id,'providerBindingSha256',provider_binding_sha256) from public.qorpera_runtime_office_activations where activation_id='${predecessor.activationId}';`,'');
 const fresh=()=>randomUUID();
 const plan={schema:'qorpera.lxd-office-reset-plan/v1',resetId:fresh(),intentId:row.intentId,predecessor,
  preparationObservationSha256:attestation.preparationObservationSha256,providerBindingSha256:row.providerBindingSha256,
  nodeId:null,predecessorRootIncarnationId:null,rootIncarnationId:fresh(),successorActivationId:fresh(),
  commands:{stopCommandId:fresh(),deleteCommandId:fresh(),createCommandId:fresh(),startCommandId:fresh()},
  custody:{archiveRoot:'/var/lib/qorpera-office-provider/reset-custody'}};
 const planSha256=officeDigest(plan);
 const begin=(p=plan,sha=planSha256)=>`select public.qorpera_begin_runtime_office_reset(${literal(p)},'${sha}');`;
 const status=(p=plan)=>`select public.qorpera_runtime_office_reset_status(${literal(p)});`;
 const prepare=(phase,challengeId,evidenceSha256,p=plan)=>`select public.qorpera_prepare_runtime_office_reset_phase(${literal(p)},'${phase}','${challengeId}','${evidenceSha256}');`;
 const check=(challengeId,p=plan)=>`select public.qorpera_check_runtime_office_reset_phase(${literal(p)},'${challengeId}');`;
 const ack=(challengeId,evidence,p=plan)=>`select public.qorpera_ack_runtime_office_reset_phase(${literal(p)},'${challengeId}',${literal(evidence)});`;
 const evidence=(phase,observation)=>({schema:'qorpera.office-reset-phase-evidence/v1',resetId:plan.resetId,phase,observation});
 const preserved=()=>execute(`select jsonb_build_object('allocations',(select jsonb_agg(a order by a.id) from public.qorpera_runtime_machine_allocations a),
  'demands',(select jsonb_agg(d order by d.allocation_id) from public.qorpera_runtime_node_demands d),
  'companyFiles',(select jsonb_agg(f order by f.environment_id) from public.qorpera_company_files f),
  'privacy',(select jsonb_build_object('state',privacy_state,'version',privacy_version,'challenge',privacy_challenge) from public.qorpera_runtime_offices),
  'generation',(select generation from public.qorpera_runtime_offices),
  'screens',(select jsonb_agg(s order by s.ordinal) from public.qorpera_runtime_office_screens s)) from public.qorpera_runtime_offices;`);
 const activations=()=>call(`select jsonb_agg(a order by a.activation_id) from public.qorpera_runtime_office_activations a;`,'');
 const reset=()=>call(`select to_jsonb(r) from public.qorpera_runtime_office_resets r where reset_id='${plan.resetId}';`,'');
 const events=()=>call(`select coalesce(jsonb_agg(e order by e.sequence),'[]') from public.qorpera_runtime_office_reset_events e where reset_id='${plan.resetId}';`,'');
 const before=preserved(),original=activations();
 assert.equal(original.length,1);assert.equal(JSON.parse(before).privacy.state,'private');
 assert.equal(execute('select state from public.qorpera_runtime_offices;'),'maintenance');

 // Closed surface: members, private tables and helpers are unavailable.
 for(const sql of [begin(),status(),prepare('stopped',fresh(),'9'.repeat(64)),check(fresh()),ack(fresh(),evidence('stopped',{x:1}))])await deny(sql,owner);
 for(const table of ['qorpera_runtime_office_resets','qorpera_runtime_office_reset_events','qorpera_runtime_office_reset_challenges'])await deny(`select * from public.${table};`);
 await deny(`select public.qorpera_lock_runtime_office_reset(${literal(plan)},false);`);
 await deny(`select public.qorpera_assert_runtime_office_reset_plan(${literal(plan)});`);
 await deny(status());
 for(const [change,pattern] of [[{extra:true},/Invalid office reset plan/],[{providerBindingSha256:'9'.repeat(64)},/Office reset origin differs/],
  [{intentId:fresh()},/Office reset origin differs/],[{preparationObservationSha256:'9'.repeat(64)},/Office reset origin differs/],
  [{nodeId:fresh()},/Office reset node binding differs/],[{predecessorRootIncarnationId:fresh()},/Office reset incarnation lineage differs/],
  [{predecessor:{...predecessor,action:'reboot'}},/replace predecessor/],[{predecessor:{...predecessor,transitionId:fresh()}},/Office stop revocation differs/],
  [{successorActivationId:predecessor.activationId},/cannot be reused/]])await refuse(begin({...plan,...change}),pattern);
 await refuse(begin(plan,'x'),/Invalid office reset plan digest/);
 assert.equal(preserved(),before);assert.deepEqual(activations(),original);
 console.log('PASS: reset begin validates the closed plan against the retained activation, allocation, node and lineage; members, helpers and private tables stay unavailable');

 // Begin is idempotent for the exact plan; identity rebinding is refused.
 const begun=call(begin());
 assert.equal(begun.schema,'qorpera.office-reset/v1');assert.equal(begun.phase,'fenced');assert.equal(begun.revision,1);
 assert.equal(begun.custodySha256,null);assert.equal(begun.restoreSha256,null);assert.equal(begun.stopAcknowledgedAtMs,stop.acknowledgement.acknowledgedAtMs);
 assert.deepEqual(call(begin()),begun);assert.deepEqual(call(status()),begun);
 await refuse(begin(plan,'8'.repeat(64)),/cannot be rebound/);
 await refuse(begin({...plan,resetId:fresh()}),/cannot be rebound/);
 await refuse(begin({...plan,resetId:fresh(),rootIncarnationId:fresh(),successorActivationId:fresh(),commands:{stopCommandId:fresh(),deleteCommandId:fresh(),createCommandId:fresh(),startCommandId:fresh()}}),/cannot be rebound/);
 assert.equal(events().length,1);assert.equal(events()[0].evidence_sha256,planSha256);assert.equal(events()[0].previous_sha256,null);
 assert.equal(reset().phase,'fenced');assert.equal(reset().node_id,null);assert.equal(reset().predecessor_root_incarnation_id,null);
 const contenders=await race([begin(),begin(),begin({...plan,resetId:fresh()})].map(sql=>`${service} ${sql}`));
 assert.equal(contenders.filter(r=>r.code===0).length,2);
 console.log('PASS: one durable reset per allocation; exact begin replays and concurrent identity substitution cannot branch the lineage');

 // Phase order, bounded nonce challenges, expiry, budget and exact replay.
 await refuse(prepare('custodied',fresh(),'1'.repeat(64)),/phase order/);
 await refuse(prepare('fenced',fresh(),'1'.repeat(64)),/phase order/);
 await refuse(prepare('prepared',fresh(),'1'.repeat(64)),/phase order/);
 await refuse(prepare('stopped',plan.commands.stopCommandId,'1'.repeat(64)),/Invalid office reset challenge/);
 await refuse(prepare('stopped',fresh(),'bad'),/Invalid office reset challenge/);
 const stopObservation={stopCommandId:stop.command.commandId,acknowledgedAtMs:stop.acknowledgement.acknowledgedAtMs,stopCompletionSha256:stop.request.startCompletionSha256};
 const stopEvidence=evidence('stopped',stopObservation),stopSha=officeDigest(stopEvidence),stopNonce=fresh();
 const challenge=call(prepare('stopped',stopNonce,stopSha));
 assert.equal(challenge.schema,'qorpera.office-reset-phase-challenge/v1');assert.equal(challenge.phase,'stopped');assert.equal(challenge.revision,1);
 assert(challenge.validForMs>0&&challenge.validForMs<=5000);assert(call(check(stopNonce)).validForMs<=challenge.validForMs);
 await refuse(prepare('stopped',stopNonce,'2'.repeat(64)),/challenge changed/);
 await refuse(check(fresh()),/challenge unavailable/);
 await refuse(ack(fresh(),stopEvidence),/challenge unavailable/);
 for(const bad of [{...stopEvidence,phase:'custodied'},{...stopEvidence,resetId:fresh()},{...stopEvidence,observation:{}},{...stopEvidence,extra:1}])await refuse(ack(stopNonce,bad),/Invalid office reset evidence/);
 for(const bad of [{...stopObservation,acknowledgedAtMs:stop.acknowledgement.acknowledgedAtMs+1},{...stopObservation,stopCommandId:fresh(),extra:true},{...stopObservation,stopCompletionSha256:'zz'}])
  await refuse(ack(stopNonce,evidence('stopped',bad)),/stop evidence differs/);
 await deny(`begin; reset role; update public.qorpera_runtime_offices set revision=revision+1; ${service} ${ack(stopNonce,stopEvidence)}`);
 await deny(`begin; reset role; update public.qorpera_runtime_offices set privacy_version=privacy_version+1; ${service} ${ack(stopNonce,stopEvidence)}`);
 let stopped,ackNonce=stopNonce;
 if(controls){
  // The real provider adapter: lost committed acknowledgement reply, then exact status recovery.
  const methods=[];let lose=true;
  const control=new controls.LxdOfficeResetControl(plan,planSha256,{call:async(method,args,signal)=>{signal.throwIfAborted();methods.push(method);
   const sql=method==='qorpera_begin_runtime_office_reset'?begin(args.p_plan,args.p_plan_sha256):method==='qorpera_runtime_office_reset_status'?status(args.p_plan)
    :method==='qorpera_prepare_runtime_office_reset_phase'?prepare(args.p_phase,args.p_challenge_id,args.p_evidence_sha256,args.p_plan)
    :method==='qorpera_check_runtime_office_reset_phase'?check(args.p_challenge_id,args.p_plan):ack(args.p_challenge_id,args.p_evidence,args.p_plan);
   const value=call(sql);
   if(method==='qorpera_ack_runtime_office_reset_phase'&&lose){lose=false;throw new Error('Lost committed acknowledgement reply');}
   return value;}});
  const signal=new AbortController().signal;
  assert.deepEqual(await control.begin(signal),begun);
  ackNonce=fresh();
  const window=await control.preparePhase('stopped',ackNonce,stopSha,signal);
  assert(window.validForMs>0&&window.validForMs<=5000);assert.equal(window.challenge.phase,'stopped');
  assert((await control.checkPhase('stopped',ackNonce,stopSha,signal)).validForMs<=window.validForMs);
  await assert.rejects(control.preparePhase('stopped',ackNonce,'2'.repeat(64),signal),/UNCONFIRMED/);
  await assert.rejects(control.ackPhase(ackNonce,stopEvidence,window.deadline,signal),/UNCONFIRMED/);
  stopped=await control.status(signal);assert.equal(stopped.phase,'stopped');
  assert.deepEqual(await control.ackPhase(ackNonce,stopEvidence,performance.now()+4000,signal),stopped);
  assert.equal(methods.filter(m=>m==='qorpera_ack_runtime_office_reset_phase').length,2);
  await assert.rejects(control.preparePhase('stopped',fresh(),stopSha,signal),/UNCONFIRMED/);
 } else stopped=call(ack(stopNonce,stopEvidence));
 assert.equal(stopped.phase,'stopped');assert.equal(stopped.revision,2);
 assert.deepEqual(call(ack(ackNonce,stopEvidence)),stopped);
 await refuse(ack(ackNonce,evidence('stopped',{...stopObservation,stopCommandId:fresh()})),/cannot be rebound/);
 await refuse(prepare('stopped',fresh(),stopSha),/phase order/);
 await refuse(check(stopNonce),/challenge unavailable/);
 assert.equal(events().length,2);assert.equal(events()[1].previous_sha256,planSha256);assert.equal(events()[1].evidence_sha256,stopSha);
 const staleNonce=fresh();call(prepare('custodied',staleNonce,'3'.repeat(64)));
 execute(`update public.qorpera_runtime_office_reset_challenges set issued_at=issued_at-interval '6 seconds',expires_at=expires_at-interval '6 seconds' where id='${staleNonce}';`);
 await refuse(check(staleNonce),/challenge expired/);await refuse(prepare('custodied',staleNonce,'3'.repeat(64)),/challenge expired/);
 await refuse(ack(staleNonce,evidence('custodied',{x:1})),/expired or changed/);
 const count=Number(execute(`select count(*) from public.qorpera_runtime_office_reset_challenges where reset_id='${plan.resetId}' and phase='custodied';`));
 const exhausted=await deny('begin; '+Array.from({length:65-count},()=>prepare('custodied',fresh(),'3'.repeat(64))).join(' ')+' rollback;');
 assert.match(exhausted.error,/challenge budget exhausted/);
 assert.equal(Number(execute(`select count(*) from public.qorpera_runtime_office_reset_challenges where reset_id='${plan.resetId}' and phase='custodied';`)),count);
 console.log('PASS: phase challenges are ordered, nonce-bound, five-second and budgeted; stale or changed challenges never acknowledge and exact replays are idempotent');

 // Custody: SQL records the provider-validated archive digest; malformed or foreign custody is refused.
 const historyRoot=`/etc/qorpera-office/history/${predecessor.startup.bootId}/${predecessor.activationId}`;
 const custody={schema:'qorpera.office-reset-custody/v1',resetId:plan.resetId,rootIncarnationId:plan.rootIncarnationId,predecessorActivationId:predecessor.activationId,
  outbox:{manifestSha256:'a'.repeat(64),recordCount:3,totalBytes:1200},
  history:{manifestSha256:'b'.repeat(64),totalBytes:900,files:[
   {path:'/etc/qorpera-office/adoption.json',bytes:100,sha256:'c'.repeat(64),mode:0o444},
   {path:'/etc/qorpera-office/credentials/config.json',bytes:200,sha256:'d'.repeat(64),mode:0o400},
   {path:`${historyRoot}/claim.json`,bytes:300,sha256:'b'.repeat(64),mode:0o600},
   {path:`${historyRoot}/manifest.json`,bytes:300,sha256:'b'.repeat(64),mode:0o600}]},
  journalHeadSha256:'e'.repeat(64),nas:{workbenchSource:binding.workbenchSource,adoptionId:fresh(),layoutSha256:'f'.repeat(64)}};
 const custodyEvidence=evidence('custodied',custody),custodySha=officeDigest(custodyEvidence),custodyNonce=fresh();
 call(prepare('custodied',custodyNonce,custodySha));
 for(const bad of [{...custody,resetId:fresh()},{...custody,history:{...custody.history,totalBytes:1}},{...custody,extra:1},
  {...custody,history:{...custody.history,files:[{path:'/etc/qorpera-office/credentials/native',bytes:1,sha256:'c'.repeat(64),mode:0o400},...custody.history.files],totalBytes:901}}])
  await refuse(ack(custodyNonce,evidence('custodied',bad)),/Invalid office reset (custody manifest|history file)|history totals differ/);
 const custodied=call(ack(custodyNonce,custodyEvidence));
 assert.equal(custodied.phase,'custodied');assert.equal(custodied.custodySha256,custodySha);assert.equal(custodied.revision,3);
 assert.deepEqual(reset().custody,custody);
 console.log('PASS: custody acknowledgement stores the exact provider archive manifest and digest; malformed, foreign and credential-bearing history is refused');

 // Destruction requires current preparation authority, no pause and drained surfaces; observation phases did not.
 const physical=(phase,commandId,extra={})=>evidence(phase,{commandId,operationId:fresh(),...extra});
 const advance=async(phase,ev)=>{const nonce=fresh();call(prepare(phase,nonce,officeDigest(ev)));const result=call(ack(nonce,ev));assert.equal(result.phase,phase);return result;};
 const poweredOff=physical('powered_off',plan.commands.stopCommandId,{instanceSha256:predecessor.startup.instanceSha256});
 const powerNonce=fresh();call(prepare('powered_off',powerNonce,officeDigest(poweredOff)));
 await refuse(ack(powerNonce,physical('powered_off',plan.commands.deleteCommandId,{instanceSha256:predecessor.startup.instanceSha256})),/physical evidence differs/);
 await refuse(ack(powerNonce,physical('powered_off',plan.commands.stopCommandId,{instanceSha256:'0'.repeat(64)})),/physical evidence differs/);
 assert.equal(call(ack(powerNonce,poweredOff)).phase,'powered_off');
 const setEnabled=enabled=>{const version=execute('select version from public.qorpera_runtime_office_providers;');
  return call(`select public.qorpera_set_runtime_office_provider(${literal(scope)},1,'${predecessor.providerId}','${predecessor.providerPolicySha256}',${version},${enabled});`);};
 const deleted=physical('root_deleted',plan.commands.deleteCommandId);
 // The stop fixture left preparation disabled and the founder pause in place:
 // observation/custody/power-off proceeded, destruction may not.
 await refuse(prepare('root_deleted',fresh(),officeDigest(deleted)),/Office provider authority unavailable/);
 setEnabled(true);
 await refuse(prepare('root_deleted',fresh(),officeDigest(deleted)),/Office restart authority unavailable/);
 execute('delete from public.qorpera_company_execution_pauses;');
 setEnabled(false);await refuse(prepare('root_deleted',fresh(),officeDigest(deleted)),/Office provider authority unavailable/);
 assert.equal(call(status()).phase,'powered_off');setEnabled(true);
 await deny(`begin; reset role; insert into public.qorpera_company_execution_pauses(profile_id,paused_by_user_id) values('${scope.companyId}','30000000-0000-4000-8000-000000000001'); ${service} ${prepare('root_deleted',fresh(),officeDigest(deleted))}`);
 await deny(`begin; reset role; update public.qorpera_runtime_office_screens set drain_pending=true,drain_id=extensions.gen_random_uuid(),drain_acknowledged_at=null; ${service} ${prepare('root_deleted',fresh(),officeDigest(deleted))}`);
 const deleteNonce=fresh();call(prepare('root_deleted',deleteNonce,officeDigest(deleted)));
 setEnabled(false);await refuse(check(deleteNonce),/Office provider authority unavailable/);await refuse(ack(deleteNonce,deleted),/Office provider authority unavailable/);setEnabled(true);
 assert.equal(call(ack(deleteNonce,deleted)).phase,'root_deleted');
 const created=physical('root_created',plan.commands.createCommandId,{instanceSha256:predecessor.startup.instanceSha256});
 const createNonce=fresh();call(prepare('root_created',createNonce,officeDigest(created)));
 await refuse(ack(createNonce,physical('root_created',plan.commands.createCommandId,{instanceSha256:'1'.repeat(64)})),/physical evidence differs/);
 assert.equal(call(ack(createNonce,created)).phase,'root_created');
 assert.equal(execute('select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;'),'1');
 assert.equal(execute('select state from public.qorpera_runtime_offices;'),'maintenance');
 console.log('PASS: VM stop, root deletion and pinned recreation are acknowledged only with the planned command identity under current preparation, unpaused and drained authority; capacity stays charged');

 // Restore binds the sealed custody digest and a fresh boot.
 const newBootId=fresh();
 const restore={schema:'qorpera.office-reset-restore/v1',resetId:plan.resetId,rootIncarnationId:plan.rootIncarnationId,custodySha256:custodySha,bootId:newBootId,
  outbox:{manifestSha256:custody.outbox.manifestSha256,fileCount:4,totalBytes:custody.outbox.totalBytes},history:{fileCount:3,totalBytes:700},
  nas:{reattached:true,layoutSha256:custody.nas.layoutSha256},state:'restored'};
 const restoreNonce=fresh();call(prepare('restored',restoreNonce,officeDigest(evidence('restored',restore))));
 for(const bad of [{...restore,custodySha256:'9'.repeat(64)},{...restore,bootId:predecessor.startup.bootId},{...restore,history:{fileCount:4,totalBytes:900}},{...restore,nas:{reattached:false,layoutSha256:custody.nas.layoutSha256}}])
  await refuse(ack(restoreNonce,evidence('restored',bad)),/Invalid office reset restore receipt/);
 await refuse(ack(restoreNonce,evidence('restored',{...restore,bootId:attestation.bootId})),/Invalid office reset restore receipt|cannot be reused/);
 const restored=call(ack(restoreNonce,evidence('restored',restore)));
 assert.equal(restored.phase,'restored');assert.equal(restored.restoreSha256,officeDigest(evidence('restored',restore)));
 assert.equal(events().length,7);for(let i=1;i<7;i++)assert.equal(events()[i].previous_sha256,events()[i-1].evidence_sha256);
 await refuse(prepare('restored',fresh(),officeDigest(evidence('restored',restore))),/phase order/);
 assert.deepEqual(activations(),original);assert.equal(preserved(),before);
 console.log('PASS: restore acknowledgement binds the sealed custody digest and a distinct boot; the chain hashes forward and no activation, allocation, privacy or canonical row changed');

 // Successor admission: exact reset chain, fresh identities, original preparation/receipt/listeners.
 const successorAttestation={...attestation,activationId:plan.successorActivationId,bootId:newBootId,configurationObservationSha256:'5'.repeat(64),configurationSha256:'6'.repeat(64)};
 const request={schema:'qorpera.office-reset-successor-request/v1',resetId:plan.resetId,rootIncarnationId:plan.rootIncarnationId,predecessor,attestation:successorAttestation,
  custodySha256:custodySha,restoreSha256:restored.restoreSha256};
 const rpc={prepare:'qorpera_prepare_runtime_office_reset_successor',status:'qorpera_runtime_office_reset_successor_status',check:'qorpera_check_runtime_office_reset_successor',activate:'qorpera_activate_runtime_office_reset_successor'};
 const sPrepare=(r=request)=>`select public.${rpc.prepare}(${literal(r)});`,sStatus=(r=request)=>`select public.${rpc.status}(${literal(r)});`;
 const sCheck=(r=request)=>`select public.${rpc.check}(${literal(r)});`,sActivate=(invocation,r=request)=>`select public.${rpc.activate}(${literal(r)},'${invocation}');`;
 const startupCheck=s=>`select public.qorpera_check_runtime_office_startup(${literal(s)});`;
 const ready=(s,id=plan.successorActivationId)=>`select public.qorpera_report_runtime_office_ready(${literal(s)},'${id}',9443,9444);`;
 for(const sql of [sPrepare(),sStatus(),sCheck(),sActivate('c'.repeat(32))])await deny(sql,owner);
 await refuse(sStatus(),/identity unavailable/);
 for(const [change,pattern] of [[{custodySha256:'9'.repeat(64)},/chain incomplete/],[{restoreSha256:'9'.repeat(64)},/chain incomplete/],
  [{rootIncarnationId:fresh()},/chain incomplete/],[{attestation:{...successorAttestation,activationId:fresh()}},/chain incomplete/],
  [{attestation:{...successorAttestation,bootId:fresh()}},/chain incomplete/],[{attestation:{...successorAttestation,configurationSha256:predecessor.startup.configurationSha256}},/distinct activation, boot and configuration/],
  [{attestation:{...successorAttestation,configurationObservationSha256:attestation.configurationObservationSha256}},/fresh boot and configuration identity/],
  [{attestation:{...successorAttestation,nativePort:9445}},/retains the original/],[{attestation:{...successorAttestation,preparationObservationSha256:'9'.repeat(64)}},/retains the original/],
  [{attestation:{...successorAttestation,adoptionReceiptSha256:'9'.repeat(64)}},/retains the original/],[{predecessor:{...predecessor,action:'reboot'}},/distinct activation|replace/],
  [{schema:'qorpera.office-boot-successor-request/v1'},/Invalid office reset successor request/]])await refuse(sPrepare({...request,...change}),pattern);
 await deny(`select public.qorpera_prepare_runtime_office_successor(${literal({schema:'qorpera.office-service-successor-request/v1',predecessor,attestation:successorAttestation})});`);
 await deny(`begin; reset role; update public.qorpera_runtime_offices set privacy_version=privacy_version+1; ${service} ${sPrepare()}`);
 await deny(`begin; reset role; update public.qorpera_runtime_office_resets set restore=null,restore_sha256=null; ${service} ${sPrepare()}`);
 setEnabled(false);await refuse(sPrepare(),/Office provider authority unavailable/);setEnabled(true);
 assert.deepEqual(activations(),original);
 const prepared=call(sPrepare());
 assert.equal(prepared.schema,'qorpera.office-reset-successor/v1');assert.equal(prepared.state,'prepared');assert.equal(prepared.serviceInvocationId,null);
 assert.deepEqual(call(sPrepare()),prepared);assert.deepEqual(call(sStatus()),prepared);assert.deepEqual(call(sCheck()),prepared);
 await refuse(sPrepare({...request,attestation:{...successorAttestation,configurationSha256:'7'.repeat(64)}}),/cannot be rebound/);
 assert.equal(call(status()).phase,'prepared');assert.equal(events().length,8);
 assert.equal(activations().length,2);const old=activations().find(a=>a.activation_id===original[0].activation_id);assert(old.superseded_at);assert.deepEqual({...old,superseded_at:null},original[0]);
 assert.equal(execute('select count(*) from public.qorpera_runtime_office_activations where superseded_at is null;'),'1');
 await deny(startupCheck(predecessor.startup));await deny(ready(predecessor.startup,predecessor.activationId));
 await deny(`select public.qorpera_begin_runtime_office_lifecycle(${literal(predecessor)});`);
 assert.equal(call(begin()).phase,'prepared');assert.equal(call(status()).phase,'prepared'); // exact identity recovery after supersession
 await deny(`begin; reset role; update public.qorpera_runtime_office_resets set restore=null,restore_sha256=null; ${service} ${sCheck()}`);
 await deny(`begin; reset role; update public.qorpera_runtime_office_resets set phase='restored'; ${service} ${sCheck()}`);
 assert.equal(preserved(),before);
 console.log('PASS: the reset successor is admitted only through the complete acknowledged chain with fresh boot/configuration and retained preparation, receipt and listeners; old startup authority is permanently fenced');

 // Fresh invocation admission, readiness and activation close the reset.
 const startup={...predecessor.startup,bootId:newBootId,configurationSha256:successorAttestation.configurationSha256,serviceInvocationId:'c'.repeat(32)};
 for(const change of [{bootId:predecessor.startup.bootId},{configurationSha256:predecessor.startup.configurationSha256}]){await deny(startupCheck({...startup,...change}));await deny(ready({...startup,...change}));}
 await deny(`begin; reset role; update public.qorpera_runtime_office_resets set custody=null,custody_sha256=null; ${service} ${startupCheck(startup)}`);
 assert.equal(call(startupCheck(startup)).state,'prepared');
 const invocations=['c'.repeat(32),'d'.repeat(32)];
 const competing=await race(invocations.map(serviceInvocationId=>`${service} ${ready({...startup,serviceInvocationId})}`));
 assert.equal(competing.filter(r=>r.code===0).length,1);startup.serviceInvocationId=invocations[competing.findIndex(r=>r.code===0)];
 execute(`update public.qorpera_runtime_office_activations set ready_at=clock_timestamp()-interval '6 seconds' where superseded_at is null;`);
 await deny(sActivate(startup.serviceInvocationId));assert.equal(call(status()).phase,'prepared');
 call(ready(startup));
 await deny(sActivate(invocations.find(i=>i!==startup.serviceInvocationId)));
 let methods=[];
 const successorControl=controls?new controls.LxdOfficeResetSuccessorControl(request,{call:async(method,args,signal)=>{signal.throwIfAborted();methods.push(method);
  const sql=method===rpc.prepare?sPrepare(args.p_request):method===rpc.status?sStatus(args.p_request):method===rpc.check?sCheck(args.p_request):sActivate(args.p_service_invocation_id,args.p_request);
  const result=call(sql);if(method===rpc.activate&&methods.filter(m=>m===rpc.activate).length===1)throw new Error('Lost committed activation reply');return result;}}):undefined;
 const signal=new AbortController().signal;
 if(successorControl){
  assert.equal((await successorControl.status(signal)).state,'ready');
  await assert.rejects(successorControl.activate(startup.serviceInvocationId,performance.now()+4000,signal),/UNCONFIRMED/);
  const active=await successorControl.status(signal);assert.equal(active.state,'active');assert.equal(active.serviceInvocationId,startup.serviceInvocationId);
  assert.equal((await successorControl.prepare(signal)).state,'active');assert.equal(methods.filter(m=>m===rpc.activate).length,1);
 } else {
  const active=await race([`${service} ${sActivate(startup.serviceInvocationId)}`,`${service} ${sActivate(startup.serviceInvocationId)}`]);
  for(const r of active)assert.equal(r.code,0,r.error);assert.deepEqual(JSON.parse(active[0].output),JSON.parse(active[1].output));
 }
 assert.equal(call(sActivate(startup.serviceInvocationId)).state,'active');
 assert.equal(execute('select state from public.qorpera_runtime_offices;'),'active');
 const finalReset=reset();assert.equal(finalReset.phase,'active');assert.equal(finalReset.revision,9);assert.equal(events().length,9);
 assert.equal(events()[8].previous_sha256,events()[7].evidence_sha256);
 if(CompanyComputerStartupControl){
  const runtime=new CompanyComputerStartupControl(startup,{call:async(method,args,checked)=>{checked.throwIfAborted();assert.deepEqual(args.p_startup,startup);
   if(method==='qorpera_check_runtime_office_startup')return call(startupCheck(startup));assert.equal(method,'qorpera_report_runtime_office_ready');return call(ready(startup));}});
  assert.equal((await runtime.check(signal)).state,'active');
 }
 await restartDatabase();
 assert.equal(call(sStatus()).state,'active');
 assert.equal(call(`select jsonb_build_object('allocations',(select count(*) from public.qorpera_runtime_machine_allocations where released_at is null),'stops',(select count(*) from public.qorpera_runtime_office_stops),'activations',(select count(*) from public.qorpera_runtime_office_activations),'resets',(select count(*) from public.qorpera_runtime_office_resets));`,'').allocations,1);
 assert.equal(JSON.parse(preserved()).privacy.state,'private');
 assert.deepEqual(JSON.parse(preserved()).allocations,JSON.parse(before).allocations);
 assert.deepEqual(JSON.parse(preserved()).companyFiles,JSON.parse(before).companyFiles);
 assert.deepEqual(JSON.parse(preserved()).demands,JSON.parse(before).demands);
 assert.equal(JSON.parse(preserved()).generation,1);
 console.log('PASS: one fresh invocation activates the reset successor through the existing startup fences; lost activation reply and database restart recover exactly, with the same allocation, generation, privacy and canonical Company File rows');

 // Lifecycle projection and a second reset lineage.
 const lifecycle=call(`select public.qorpera_runtime_computer_lifecycle('${predecessor.startup.allocationId}',statement_timestamp()-interval '1 hour',statement_timestamp());`);
 const resetEvents=lifecycle.controlEvents.filter(e=>e.layer==='root_incarnation');
 assert.deepEqual(resetEvents.map(e=>e.event),PHASES.map(phase=>`reset_${phase}`));
 for(const e of resetEvents){assert.equal(e.timeBasis,'database_recorded');assert.equal(e.physicalTransitionAt,null);assert.equal(e.rootIncarnationId,plan.rootIncarnationId);assert.equal(e.action,'replace');assert.equal(e.transitionId,predecessor.transitionId);}
 assert.equal(resetEvents.find(e=>e.event==='reset_custodied').custodyConfirmation,'provider_validated_external_archive_digest');
 assert.equal(resetEvents.find(e=>e.event==='reset_restored').custodyConfirmation,'provider_validated_external_archive_digest');
 assert.equal(resetEvents.find(e=>e.event==='reset_root_deleted').custodyConfirmation,'sql_recorded_phase_digest');
 assert.equal(resetEvents.find(e=>e.event==='reset_prepared').activationId,plan.successorActivationId);
 assert.equal(resetEvents.find(e=>e.event==='reset_powered_off').activationId,predecessor.activationId);
 assert(lifecycle.controlEvents.filter(e=>e.layer!=='root_incarnation').every(e=>e.custodyConfirmation===null&&e.rootIncarnationId===null));
 assert.deepEqual(lifecycle.rootIncarnations.map(r=>({id:r.rootIncarnationId,previous:r.predecessorRootIncarnationId,phase:r.phase,custody:r.custodyConfirmation})),
  [{id:plan.rootIncarnationId,previous:null,phase:'active',custody:'provider_validated_external_archive_digest'}]);
 assert(!lifecycle.controlEvents.some(e=>e.event==='released'));
 const next={...plan,resetId:fresh(),rootIncarnationId:fresh(),successorActivationId:fresh(),predecessorRootIncarnationId:null,
  commands:{stopCommandId:fresh(),deleteCommandId:fresh(),createCommandId:fresh(),startCommandId:fresh()},
  predecessor:{...predecessor,transitionId:fresh(),activationId:plan.successorActivationId,startup}};
 await deny(begin(next,officeDigest(next))); // Office is active again: no revocation, no maintenance.
 const transition=call(`select public.qorpera_begin_runtime_office_lifecycle(${literal(next.predecessor)});`);
 assert.equal(transition.state,'draining');
 await refuse(begin(next,officeDigest(next)),/incarnation lineage differs|stop unacknowledged|Office reset/);
 const lineage={...next,predecessorRootIncarnationId:plan.rootIncarnationId};
 const lineageBegun=call(begin(lineage,officeDigest(lineage)));
 assert.equal(lineageBegun.phase,'fenced');assert.equal(lineageBegun.stopAcknowledgedAtMs,null);
 await refuse(prepare('stopped',fresh(),'1'.repeat(64),lineage),/stop unacknowledged/);
 assert.equal(execute('select count(*) from public.qorpera_runtime_office_resets;'),'2');
 assert.equal(execute('select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;'),'1');
 console.log('PASS: the lifecycle projection separates root-incarnation events with their custody class; a later reset must name the current incarnation and waits for its own acknowledged stop');
 return {plan,custody,restore,request,startup,resetId:plan.resetId,rootIncarnationId:plan.rootIncarnationId};
}
