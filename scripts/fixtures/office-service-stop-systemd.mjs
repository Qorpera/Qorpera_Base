import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,chown,lstat,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const run=(file,args,timeout=15000)=>spawnSync(file,args,{encoding:'utf8',timeout});
const ok=(file,args,timeout)=>{const r=run(file,args,timeout);assert.equal(r.status,0,r.stdout+' '+r.stderr);return r.stdout.trim();};
const root='/run/qorpera-office-preparation',unit='qorpera-company-computer.service',exe='/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),encode=v=>Buffer.from(JSON.stringify(v)+'\n'),load=async p=>JSON.parse(await readFile(p,'utf8'));
const cases=[],check=name=>{cases.push(name);console.log('PASS '+name);};
// Install the unchanged real units and packaged root controls into the clean
// disposable image. The installation fixture itself leaves no configured state.
const installation = ok('/usr/bin/node',['/fixture/install-check.mjs'],120000);
const installedProof = installation.split('\n').find(line => line.startsWith('GUEST_IMAGE_INSTALL_PROOF='));
assert(installedProof);console.log(installedProof);
ok('/usr/bin/node',['/probe.mjs','--seed'],30000);
ok('/usr/bin/mount',['-t','tmpfs','-o','nodev,nosuid,mode=0700,uid=1100,gid=1100,size=16m','tmpfs','/var/lib/qorpera-office']);
const work='/var/lib/qorpera-office/retained-work';await writeFile(work,'mutable company work retained through stop\n',{mode:0o600});await chown(work,1100,1100);const original=await readFile(work);
const restart = process.env.OFFICE_TEST_RESTART === '1' ? await import('/fixture/restart-check.mjs') : null;
if(restart)await restart.prepareActualRestartFixture(ok);
// Synthetic workload only; the real repository unit, root stop executable,
// systemctl, namespaces, kernel cgroup and descendant cleanup are exercised.
await writeFile('/opt/qorpera-office/qorpera-company-computer-service.mjs',`import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});writeFileSync('/var/lib/qorpera-office/processes.json',JSON.stringify({main:process.pid,child:child.pid}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`,{mode:0o444});
await chmod('/opt/qorpera-office/qorpera-company-computer-service.mjs',0o444);
ok('/usr/bin/systemctl',['start',unit],20000);
let processes;
for(let n=0;n<40;n++){try{processes=await load('/var/lib/qorpera-office/processes.json');break;}catch{await delay(100);}}
assert(processes);await delay(200);
const observe=()=>JSON.parse(ok('/usr/bin/node',['/fixture/consumer.mjs']));
const live=observe();assert.equal(live.service.activeState,'active');assert.equal(live.cgroupState,'populated');assert.equal(live.service.mainPid,processes.main);check('real systemd service and detached descendant populate the fixed cgroup');
for(const kind of ['--mount','--cgroup']){const probe=run('/usr/bin/unshare',[kind,'/usr/bin/node','/fixture/consumer.mjs']);assert.equal(probe.status,1,probe.stderr);assert.match(probe.stderr,/OFFICE_STOP_OBSERVATION_UNCONFIRMED/);}
check('private mount and cgroup namespaces cannot attest the guest service');
const prior=await load(root+'/service-start-completion.json');prior.serviceInvocationId=live.service.invocationId;prior.mainPid=live.service.mainPid;
await writeFile(root+'/service-start-completion.json',encode(prior));
const config=await load('/etc/qorpera-office/credentials/config.json');
const request={schema:'qorpera.office-service-stop-request/v1',startCompletionSha256:hash(await readFile(root+'/service-start-completion.json')),revocation:{schema:'qorpera.office-lifecycle-transition/v1',state:'draining',revocationRevision:2,requestedAtMs:Date.now(),drains:[],request:{schema:'qorpera.office-lifecycle-request/v1',transitionId:randomUUID(),action:'service_restart',activationId:prior.activationId,providerId:randomUUID(),providerPolicySha256:'f'.repeat(64),startup:{scope:config.scope,computerGeneration:config.computerGeneration,allocationId:config.linux.attestation.allocationId,instanceSha256:config.linux.attestation.instanceSha256,imageSha256:config.linux.attestation.imageSha256,bootstrapSha256:config.linux.attestation.bootstrapSha256,bootId:config.linux.attestation.bootId,configurationSha256:prior.configurationSha256,serviceInvocationId:prior.serviceInvocationId}}}};
const command=[randomUUID(),hash(encode(request)),config.linux.attestation.bootId];
await writeFile(root+'/service-stop-incoming-'+command[1]+'.json',encode(request),{mode:0o400});
assert.equal(run('/usr/bin/node',[exe,'--locked',...command]).status,1);assert.equal(observe().service.activeState,'active');check('internal stop refuses missing kernel ownership without stopping the live unit');
ok('/usr/bin/node',[exe,...command],100000);
const stopped=observe();assert.equal(stopped.service.mainPid,0);assert.equal(stopped.service.controlPid,0);assert.equal(stopped.service.jobId,0);assert(['inactive','failed'].includes(stopped.service.activeState));assert(['empty','absent'].includes(stopped.cgroupState));
for(let n=0;n<40;n++){let live=false;for(const pid of [processes.main,processes.child])try{process.kill(pid,0);live=true;}catch{}if(!live)break;await delay(50);}
for(const pid of [processes.main,processes.child])assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
check('packaged root stop confirms inactive unit and kills the detached TERM-resistant descendant');
const completionPath=root+'/service-stop-completion.json',bytes=await readFile(completionPath),inode=(await lstat(completionPath)).ino,completion=JSON.parse(bytes);
assert.equal(completion.fromServiceInvocationId,live.service.invocationId);assert.equal(completion.observedInvocationId,live.service.invocationId);assert.equal((await lstat(completionPath)).mode&0o7777,0o600);
ok('/usr/bin/node',[exe,...command]);assert((await readFile(completionPath)).equals(bytes));assert.equal((await lstat(completionPath)).ino,inode);check('same stop recovers without replacing its claim or completion');
const nonce=randomUUID();ok('/usr/bin/node',[exe,...command,nonce]);const inspection=await load(root+'/service-stop-inspection-'+nonce+'.json');assert.equal(inspection.inspectionId,nonce);assert.deepEqual(inspection.stop,completion);assert(['absent','empty'].includes(inspection.cgroupState));check('fresh packaged inspection observes current stopped state without another stop');
const start=await load(root+'/fixture-start-command.json');assert.equal(run('/usr/bin/node',['/opt/qorpera-office/qorpera-company-computer-service-start-control.mjs',start.commandId,start.requestSha256,start.bootId]).status,1);assert.equal(observe().service.mainPid,0);check('retained stop claim prevents first-start replay');
assert((await readFile(work)).equals(original));check('mutable workbench bytes remain unchanged');
if(restart)await restart.testActualServiceRestarts({ok,run,observe,check,originalStopRequest:request,originalStopInspection:inspection,work,workBytes:original});
// This final case deliberately bypasses the protected command as guest root.
// Clear the disposable fixture's start budget after its extra restart cycles;
// the protected restart path above never resets systemd's rate limit.
if(restart)ok('/usr/bin/systemctl',['reset-failed',unit]);
ok('/usr/bin/systemctl',['start',unit],20000);assert.equal(run('/usr/bin/node',[exe,...command,randomUUID()]).status,1);assert((await readFile(completionPath)).equals(bytes));check('old stop completion cannot attest a root-started replacement invocation');
ok('/usr/bin/systemctl',['stop',unit],80000);
console.log('OFFICE_SERVICE_STOP_SYSTEMD_PROOF='+JSON.stringify({checks:cases,node:process.version,arch:process.arch,actualSystemd:true,actualKernelCgroup:true,actualKernelFlock:true,actualDetachedProcessCleanup:true,workbenchRetained:true,ordinaryWorkload:'synthetic',revocationAuthority:'synthetic',realNas:false,realKvm:false,deployed:false,modelCalls:false}));
