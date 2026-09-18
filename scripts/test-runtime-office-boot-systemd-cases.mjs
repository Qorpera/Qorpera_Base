import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

// Combines real SQL admission and adapters with the packaged current-boot root
// controls. Initial preparation/boot/stop and VM observations remain fixtures.
// This is not the LXD worker acceptance: its pinned virtiofs needs an actual VM.
export async function testOfficeBootSystemd({guest,scope,binding,instanceSha256,providerBindingSha256,intent,service,literal,execute,restartDatabase,contracts:c,bootConfigurationFixture,officeStopHistoryFixture,LxdOfficeBootIntentControl,LxdOfficeBootSuccessorControl,LxdOfficeSuccessorControl,LxdOfficeStopControl}){
 const hash=b=>createHash('sha256').update(b).digest('hex'),encode=v=>Buffer.from(JSON.stringify(v)+'\n');
 const signal=()=>new AbortController().signal;
 const arg=v=>typeof v==='string'?"'"+v.replaceAll("'","''")+"'":typeof v==='number'?String(v):literal(v);
 const rpc=(method,...args)=>{assert(/^qorpera_[a-z_]+$/.test(method));const out=execute(`${service} select public.${method}(${args.map(arg).join(',')});`);return out?JSON.parse(out):null;};
 const losses=new Set(),sqlCalls=[];
 const registry={call:async(method,args,checked)=>{
  checked.throwIfAborted();const values=[args.p_request];
  if(method==='qorpera_prepare_runtime_office_stop')values.push(args.p_command,args.p_inspection_id,args.p_start_completion_sha256);
  else if(method==='qorpera_ack_runtime_office_stop')values.push(args.p_inspection);
  else if(method.startsWith('qorpera_activate_'))values.push(args.p_service_invocation_id);
  const value=rpc(method,...values);sqlCalls.push(method);
  const key=method+':'+(args.p_request.attestation?.activationId??args.p_request.bootIntentId??args.p_request.transitionId);
  if((method.startsWith('qorpera_prepare_runtime_office_')&&method!=='qorpera_prepare_runtime_office_stop'||method.startsWith('qorpera_activate_')||method==='qorpera_ack_runtime_office_stop')&&!losses.has(key)){losses.add(key);throw new Error('lost committed SQL reply');}
  checked.throwIfAborted();return value;
 }};
 const recoverPreparation=async(make)=>{await assert.rejects(make().prepare(signal()),/UNCONFIRMED/);await restartDatabase();const recovered=make();assert.equal((await recovered.status(signal())).state,'prepared');return recovered;};
 const read=async(path,mode)=>{const file=await guest.read(path);assert(file,path);assert.equal(file.uid,0);assert.equal(file.gid,0);if(mode!==undefined)assert.equal(Number.parseInt(file.mode,8),mode);return file.content;};
 const invoke=async(kind,packet,bootId=guest.bootId)=>{
  const bytes=encode(packet),command={commandId:randomUUID(),requestSha256:hash(bytes),bootId};
  await guest.stage(`/run/qorpera-office-preparation/${kind}-incoming-${command.requestSha256}.json`,bytes);
  const argv=['/usr/bin/env','-i','/usr/bin/node',`/opt/qorpera-office/qorpera-company-computer-${kind}-control.mjs`,command.commandId,command.requestSha256,command.bootId];
  return{command,argv,execute:()=>guest.execute(argv),inspect:nonce=>guest.execute([...argv,nonce])};
 };
 const f=bootConfigurationFixture({bootId:guest.bootId,mount:guest.mount,uid:guest.uid,tlsCert:guest.tlsCert,tlsKey:guest.tlsKey,original:{scope,allocationId:binding.allocationId,instanceSha256,imageSha256:binding.imageFingerprint,bootstrapSha256:binding.bootstrapSha256}});
 const original=f.original,originalConfig=f.originFiles.get('/etc/qorpera-office/credentials/config.json').bytes;
 const firstAttestation={schema:'qorpera.office-activation-attestation/v1',activationId:randomUUID(),bootId:original.bootId,preparationObservationSha256:'1'.repeat(64),configurationObservationSha256:'2'.repeat(64),configurationSha256:hash(originalConfig),adoptionReceiptSha256:hash(f.originFiles.get('/etc/qorpera-office/adoption.json').bytes),nativePort:9443,viewerPort:9444};
 const initial={scope,computerGeneration:1,allocationId:binding.allocationId,instanceSha256,imageSha256:binding.imageFingerprint,bootstrapSha256:binding.bootstrapSha256,bootId:original.bootId,configurationSha256:firstAttestation.configurationSha256,serviceInvocationId:'a'.repeat(32)};
 assert.equal(rpc('qorpera_prepare_runtime_office_activation',scope,1,intent,binding.allocationId,instanceSha256,providerBindingSha256,binding.providerId,binding.providerPolicySha256,[],firstAttestation).state,'prepared');
 rpc('qorpera_report_runtime_office_ready',initial,firstAttestation.activationId,9443,9444);
 assert.equal(rpc('qorpera_activate_runtime_office',scope,1,intent,firstAttestation.activationId,binding.providerId,binding.providerPolicySha256,initial.serviceInvocationId).state,'active');
 const predecessor=c.parseCompanyComputerLifecycleRequest({schema:'qorpera.office-lifecycle-request/v1',action:'reboot',transitionId:randomUUID(),activationId:firstAttestation.activationId,providerId:binding.providerId,providerPolicySha256:binding.providerPolicySha256,startup:initial});
 const priorStop=c.parseCompanyComputerServiceStopRequest({schema:'qorpera.office-service-stop-request/v1',revocation:rpc('qorpera_begin_runtime_office_lifecycle',predecessor),startCompletionSha256:'4'.repeat(64)});
 const priorCommand={commandId:randomUUID(),requestSha256:hash(encode(priorStop)),bootId:original.bootId};
 const priorCompletion=c.parseCompanyComputerServiceStopCompletion({schema:'qorpera.office-service-stop-completion/v1',command:priorCommand,transitionId:predecessor.transitionId,activationId:predecessor.activationId,revocationRevision:priorStop.revocation.revocationRevision,configurationSha256:initial.configurationSha256,startCompletionSha256:priorStop.startCompletionSha256,fromServiceInvocationId:initial.serviceInvocationId,observedInvocationId:initial.serviceInvocationId,stoppedInvocationId:initial.serviceInvocationId,controlGroup:'/system.slice/qorpera-company-computer.service',cgroupState:'absent'},priorCommand,priorStop);
 const priorNonce=randomUUID();rpc('qorpera_prepare_runtime_office_stop',predecessor,priorCommand,priorNonce,priorStop.startCompletionSha256);
 rpc('qorpera_ack_runtime_office_stop',predecessor,{schema:'qorpera.office-service-stop-inspection/v1',inspectionId:priorNonce,cgroupState:'absent',stop:priorCompletion});
 const originFiles=new Map([...f.originFiles].map(([path,file])=>[path,{content:file.bytes,mode:file.mode}]));
 originFiles.set(`/run/qorpera-office-preparation/service-stop-incoming-${priorCommand.requestSha256}.json`,{content:encode(priorStop),mode:0o400});
 originFiles.set('/run/qorpera-office-preparation/service-stop-completion.json',{content:encode(priorCompletion),mode:0o600});
 const archive=officeStopHistoryFixture(originFiles,priorCommand,predecessor.activationId,'/run/qorpera-office-preparation/service-stop-completion.json');
 const historyPath=c.companyComputerStopHistoryDirectory(original.bootId,predecessor.activationId)+'/manifest.json';
 const seeds=new Map([...f.originFiles,...[...archive].map(([path,bytes])=>[path,{bytes,mode:0o600}])]);await guest.seed(seeds);
 const hostBootId=randomUUID(),powerOffCompletion=encode({schema:'qorpera.lxd-office-power-off-completion/v1',intentId:intent,allocationId:binding.allocationId,transitionId:predecessor.transitionId,commandId:randomUUID(),requestSha256:'5'.repeat(64),operationId:randomUUID(),instanceSha256,hostBootId}).toString();
 const bootRequest=c.parseCompanyComputerBootIntentRequest({schema:'qorpera.office-boot-intent-request/v1',bootIntentId:randomUUID(),activationId:randomUUID(),predecessor,stopHistorySha256:hash(archive.get(historyPath)),powerOffCompletionSha256:hash(powerOffCompletion)});
 const intentControl=await recoverPreparation(()=>new LxdOfficeBootIntentControl(bootRequest,registry));
 const bootIntent=(await intentControl.check(signal())).intent;
 const observation=c.parseCompanyComputerResumeObservation({schema:'qorpera.lxd-office-resume-observation/v1',intentId:intent,allocationId:binding.allocationId,bootIntentId:bootRequest.bootIntentId,activationId:bootRequest.activationId,startCommandId:randomUUID(),requestSha256:'6'.repeat(64),powerOffCompletionSha256:bootRequest.powerOffCompletionSha256,stopHistorySha256:bootRequest.stopHistorySha256,hostBootId,bootId:guest.bootId,instanceSha256,operationId:randomUUID()},bootRequest);
 const originPreparationSha256=hash(f.originFiles.get('/etc/qorpera-office/preparation.json').bytes),bootObservationSha256=hash(c.companyComputerResumeObservationCanonical(observation,bootRequest));
 // Match the production payload builder: retain the exact SQL-returned intent
 // representation when deriving the receipt bytes embedded in this packet.
 const receipt=c.companyComputerBootAdoptionReceipt(original,originPreparationSha256,firstAttestation.adoptionReceiptSha256,bootIntent.request,observation,bootObservationSha256);
 const config=JSON.parse(originalConfig);config.linux.attestation={...config.linux.attestation,bootId:guest.bootId,adoptionReceiptPath:c.companyComputerBootAdoptionReceiptPath(guest.bootId),adoptionReceiptSha256:hash(encode(receipt))};
 const input=c.parseCompanyComputerBootConfigurationRequest({schema:'qorpera.office-boot-configuration-request/v1',originPreparationSha256,bootIntent,observation,powerOffCompletion,material:{...f.input.material,configuration:JSON.stringify(config)}});
 const configuration=await invoke('boot-configuration',input);await configuration.execute();
 const directory=c.companyComputerBootDirectory(guest.bootId),configCompletionBytes=await read(directory+'/configuration-completion.json',0o600);
 const expectedConfiguration={schema:'qorpera.office-boot-configuration-completion/v1',command:configuration.command,bootIntentId:bootRequest.bootIntentId,activationId:bootRequest.activationId,originPreparationSha256,adoptionReceiptSha256:hash(encode(receipt)),bootObservationSha256,files:Object.fromEntries(Object.entries(c.COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key,name])=>[name,{bytes:Buffer.byteLength(input.material[key]),sha256:hash(input.material[key])}]))};
 const configCompletion=c.parseCompanyComputerBootConfigurationCompletion(JSON.parse(configCompletionBytes),expectedConfiguration);
 assert.equal(configCompletion.adoptionReceiptSha256,hash(encode(receipt)));assert((await read(directory+'/adoption.json',0o444)).equals(encode(receipt)));
 await restartDatabase();assert((await read(directory+'/configuration-completion.json',0o600)).equals(configCompletionBytes));
 const attestation={...firstAttestation,activationId:bootRequest.activationId,bootId:guest.bootId,configurationObservationSha256:hash(configCompletionBytes),configurationSha256:hash(input.material.configuration),adoptionReceiptSha256:hash(encode(receipt))};
 const successorRequest=c.parseCompanyComputerBootSuccessorRequest({schema:'qorpera.office-boot-successor-request/v1',predecessor,attestation,bootIntentId:bootRequest.bootIntentId,stopHistorySha256:bootRequest.stopHistorySha256,powerOffCompletionSha256:bootRequest.powerOffCompletionSha256,bootObservationSha256});
 const bootControl=await recoverPreparation(()=>new LxdOfficeBootSuccessorControl(successorRequest,registry));
 const startPacket=c.parseCompanyComputerBootServiceStartRequest({schema:'qorpera.office-boot-service-start-request/v1',successor:(await bootControl.check(signal())).successor,configuration:configCompletion,configurationCompletionSha256:hash(configCompletionBytes)});
 await assert.rejects(intentControl.check(signal()),/UNCONFIRMED/);
 const startCommand=await invoke('boot-service-start',startPacket);await startCommand.execute();
 const root='/run/qorpera-office-preparation';
 let completionBytes=await read(root+'/boot-service-start-completion.json',0o600);
 let completion=c.parseCompanyComputerBootServiceStartCompletion(JSON.parse(completionBytes),startCommand.command,startPacket);
 let currentStartup={...initial,bootId:guest.bootId,configurationSha256:attestation.configurationSha256,serviceInvocationId:completion.serviceInvocationId};
 const activate=async(control,command,packet,isRestart)=>{
  const nonce=randomUUID(),deadline=performance.now()+5000;await command.inspect(nonce);
  const inspected=JSON.parse(await read(root+`/${isRestart?'boot-service-restart-inspection':'boot-service-inspection'}-${nonce}.json`,0o600));
  assert.deepEqual(inspected.start,completion);assert.equal(rpc('qorpera_check_runtime_office_startup',currentStartup).state,'prepared');
  rpc('qorpera_report_runtime_office_ready',currentStartup,packet.successor.request.attestation.activationId,9443,9444);
  await assert.rejects(control.activate(completion.serviceInvocationId,deadline,signal()),/UNCONFIRMED/);
  await restartDatabase();assert.equal((await control.status(signal())).state,'active');
 };
 await activate(bootControl,startCommand,startPacket,false);
 const allInvocations=new Set([completion.serviceInvocationId]);
 const fixedConfiguration=await read(directory+'/credentials/config.json',0o400);
 let latestStop,latestAck,latestStopBytes;
 for(let cycle=0;cycle<3;cycle++){
  const lifecycle=c.parseCompanyComputerLifecycleRequest({...predecessor,action:cycle===2?'power_off':'service_restart',transitionId:randomUUID(),activationId:completion.activationId,startup:currentStartup});
  const stopRequest=c.parseCompanyComputerServiceStopRequest({schema:'qorpera.office-service-stop-request/v1',revocation:rpc('qorpera_begin_runtime_office_lifecycle',lifecycle),startCompletionSha256:hash(completionBytes)});
  const command=await invoke('service-stop',stopRequest),control=new LxdOfficeStopControl(stopRequest,command.command,registry);
  await control.prepare(randomUUID(),signal());await command.execute();
  const nonce=randomUUID();await control.prepare(nonce,signal());await command.inspect(nonce);
  const inspection=JSON.parse(await read(root+'/service-stop-inspection-'+nonce+'.json',0o600));
  c.parseCompanyComputerServiceStopCompletion(inspection.stop,command.command,stopRequest);
  await assert.rejects(control.acknowledge(inspection,signal()),/UNCONFIRMED/);await restartDatabase();
  const recovered=new LxdOfficeStopControl(stopRequest,command.command,registry);latestAck=await recovered.status(signal());assert.equal(latestAck.state,'stopped');assert.deepEqual(latestAck.inspection,inspection);
  latestStop=stopRequest;latestStopBytes=await read(root+'/service-stop-completion-'+lifecycle.activationId+'.json',0o600);
  assert((await read(directory+'/credentials/config.json',0o400)).equals(fixedConfiguration));
  assert.equal(execute('select count(*) from public.qorpera_runtime_machine_allocations where released_at is null;'),'1');
  assert.equal(execute('select state from public.qorpera_runtime_offices;'),'maintenance');
  if(cycle===2)break;
  const request=c.parseCompanyComputerServiceSuccessorRequest({schema:'qorpera.office-service-successor-request/v1',predecessor:lifecycle,attestation:{...attestation,activationId:randomUUID()}});
  const successor=await recoverPreparation(()=>new LxdOfficeSuccessorControl(request,registry));
  const restartPacket=c.parseCompanyComputerBootServiceRestartRequest({schema:'qorpera.office-boot-service-restart-request/v1',origin:startPacket,successor:(await successor.check(signal())).successor,stop:latestStop,acknowledgement:latestAck,stopCompletionSha256:hash(latestStopBytes)});
  const restart=await invoke('boot-service-restart',restartPacket);await restart.execute();
  completionBytes=await read(root+'/boot-service-restart-completion-'+request.attestation.activationId+'.json',0o600);
  completion=c.parseCompanyComputerBootServiceRestartCompletion(JSON.parse(completionBytes),restart.command,restartPacket);
  assert(!allInvocations.has(completion.serviceInvocationId));allInvocations.add(completion.serviceInvocationId);
  currentStartup={...currentStartup,serviceInvocationId:completion.serviceInvocationId};
  await activate(successor,restart,restartPacket,true);
 }
 assert.equal(allInvocations.size,3);assert.equal(execute('select count(*) from public.qorpera_runtime_office_activations;'),'4');
 assert.equal(execute('select count(*) from public.qorpera_runtime_office_activations where superseded_at is null;'),'1');
 assert.equal(execute('select count(*) from public.qorpera_runtime_office_stops;'),'4');assert.equal(execute('select count(*) from public.qorpera_runtime_office_boot_intents;'),'1');
 const proof=await guest.proof();assert.equal(proof.counts['boot-configuration'],1);assert.equal(proof.counts['boot-service-start'],1);assert.equal(proof.counts['boot-service-restart'],2);assert.equal(proof.counts['service-stop'],3);assert.equal(proof.descendantsStopped,3);assert.equal(proof.invocations.length,3);assert.equal(proof.serviceState,'inactive');assert(proof.preparationNeverStarted&&proof.retainedWorkPreserved);
 assert.equal(losses.size,10);assert.equal(sqlCalls.filter(m=>m==='qorpera_activate_runtime_office_boot_successor').length,1);assert.equal(sqlCalls.filter(m=>m==='qorpera_activate_runtime_office_successor').length,2);assert.equal(sqlCalls.filter(m=>m==='qorpera_ack_runtime_office_stop').length,3);
 return{...proof,actualPostgres:true,actualAdmissionAdapters:true,lostCommittedReplies:losses.size,sqlActivationHistories:4,sqlStopReceipts:4,chargedAllocations:1,fullLxdWorkerComposition:false,vmObservations:'synthetic',readiness:'fixture reports actual measured systemd invocation',deployed:false,modelCalls:false};
}
