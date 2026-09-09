import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, chown, cp, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { bootServiceStartFixture } from "/fixture/data.mjs";
import {createHash} from "node:crypto";
const encode=value=>Buffer.from(JSON.stringify(value)+"\n"), hash=bytes=>createHash("sha256").update(bytes).digest("hex");
import { parseRecoveryDirectoryMount } from "/fixture/mount.mjs";

const command = (file,args) => { const r = spawnSync(file,args,{encoding:"utf8",timeout:120000}); assert.equal(r.status,0,r.stdout+" "+r.stderr); return r.stdout.trim(); };
const ctl = (...args) => command("/usr/bin/systemctl",args);
const property = (unit,key) => ctl("show",unit,"--property="+key,"--value");
const pkg = "/run/boot-proof-package";
await cp("/fixture/package",pkg,{recursive:true}); await chmod(pkg,0o755);
const manifest = await readFile(pkg+"/manifest.json");
for (const file of JSON.parse(manifest).artifacts) await chmod(pkg+"/"+file.file,0o444);
await chmod(pkg+"/manifest.json",0o444);
const installer = pkg+"/qorpera-office-image-install.cjs";
const dependencies = JSON.parse(command("/usr/bin/node",[installer,"--measure-dependencies"]));
const spec = { schema:"qorpera.office-image-installation/v1", packageRoot:pkg, packageManifestSha256:hash(manifest), uid:1100, gid:1100, architecture:process.arch, dependencies };
await writeFile("/run/boot-proof-spec.json",JSON.stringify(spec),{mode:0o444});
command("/usr/bin/node",[installer,"--apply","--spec","/run/boot-proof-spec.json"]);
const unit = "qorpera-company-computer.service", prep = "qorpera-company-computer-preparation.service";
const idle = () => { for(const name of [unit,prep]) { assert.equal(property(name,"ActiveState"),"inactive"); assert.equal(property(name,"InvocationID"),""); assert.equal(property(name,"MainPID"),"0"); } };
idle();
// Assemble the clean image first; attach retained state only afterwards.
command("mount",["--bind","/fixture/workbench","/var/lib/qorpera-office"]);
const bootId = (await readFile("/proc/sys/kernel/random/boot_id","utf8")).trim();
const fd = await open("/var/lib/qorpera-office","r"); let mount;
try { mount = parseRecoveryDirectoryMount(await readFile("/proc/self/mountinfo","utf8"),await readFile(`/proc/self/fdinfo/${fd.fd}`,"utf8")); } finally { await fd.close(); }
assert.equal(mount.mountPoint,"/var/lib/qorpera-office"); assert.notEqual(mount.filesystem,"tmpfs");
const cert = "/run/boot-proof-cert", key = "/run/boot-proof-key";
command("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost"]);
const f = bootServiceStartFixture({ bootId,mount,uid:1100,tlsCert:await readFile(cert,"utf8"),tlsKey:await readFile(key,"utf8") });
for(const [path,file] of f.originFiles) { await mkdir(dirname(path),{recursive:true,mode:path.includes('/credentials/')?0o700:0o755}); await writeFile(path,file.bytes,{mode:file.mode}); }
await mkdir(f.historyDirectory,{recursive:true,mode:0o700});
for(const [path,bytes] of f.archiveFiles) { await mkdir(dirname(path),{recursive:true,mode:0o700}); await writeFile(path,bytes,{mode:0o600}); }
const adoptionRoot = dirname(f.receipt.layout.workbenchRoot);
for(const path of [adoptionRoot,...Object.values(f.receipt.layout)]) { await mkdir(path,{mode:0o700}); await chown(path,1100,1100); }
const note = f.receipt.layout.workbenchRoot+"/note";
await writeFile(note,"edited since the original copy",{mode:0o600}); await chown(note,1100,1100);
const snapshot = async paths => Promise.all(paths.map(async path => {const stat=await lstat(path);return {path,ino:stat.ino,mode:stat.mode,uid:stat.uid,gid:stat.gid,sha256:hash(await readFile(path))};}));
const preserved = [...f.originFiles.keys(),...f.archiveFiles.keys(),note], before = await snapshot(preserved);
await writeFile(`/run/qorpera-office-preparation/boot-configuration-incoming-${f.command.requestSha256}.json`,encode(f.input),{mode:0o400});
const argv = ["-i","/usr/bin/node","/opt/qorpera-office/qorpera-company-computer-boot-configuration-control.mjs",f.command.commandId,f.command.requestSha256,bootId];
command("/usr/bin/env",argv);
const directory = `/etc/qorpera-office/boots/${bootId.replaceAll("-","")}`;
assert.deepEqual(JSON.parse(await readFile(directory+"/configuration-completion.json","utf8")),f.completion);
assert.deepEqual(JSON.parse(await readFile(directory+"/adoption.json","utf8")),f.receipt);
const newFiles=[directory+"/adoption.json",directory+"/configuration-claim.json",directory+"/configuration-completion.json",...Object.keys(f.completion.files).map(name=>directory+"/credentials/"+name)];
const installed = await snapshot(newFiles);
command("/usr/bin/env",argv); assert.deepEqual(await snapshot(newFiles),installed); assert.deepEqual(await snapshot(preserved),before); idle();

// The ordinary workload is synthetic. Unit, credentials, root helper,
// kernel flock and cgroup observations are actual; SQL and prior boot are fixtures.
await writeFile("/opt/qorpera-office/qorpera-company-computer-service.mjs", `import{readFileSync,readdirSync,writeFileSync,openSync,fsyncSync,closeSync}from'node:fs';import{createHash}from'node:crypto';
const root=process.env.CREDENTIALS_DIRECTORY,config=JSON.parse(readFileSync(root+'/qorpera-office-config'));
const credentials=Object.fromEntries(readdirSync(root).map(name=>[name,createHash('sha256').update(readFileSync(root+'/'+name)).digest('hex')]));
const state='/var/lib/qorpera-office-events',pending=state+'/synthetic-pending.json';
try{const fd=openSync(pending,'wx',0o600);writeFileSync(fd,'retained diagnostic observation');fsyncSync(fd);closeSync(fd);const dir=openSync(state,'r');fsyncSync(dir);closeSync(dir);}catch(error){if(error.code!=='EEXIST')throw error;}
writeFileSync(config.linux.layout.workbenchRoot+'/service-proof.json',JSON.stringify({invocationId:process.env.INVOCATION_ID,pid:process.pid,credentials}));
process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,{mode:0o444});
await chmod("/opt/qorpera-office/qorpera-company-computer-service.mjs",0o444);
const controlRoot="/run/qorpera-office-preparation", start=f.startCommand;
await writeFile(controlRoot+"/boot-service-start-incoming-"+start.requestSha256+".json",encode(f.request),{mode:0o400});
const startArgv=["-i","/usr/bin/node","/opt/qorpera-office/qorpera-company-computer-boot-service-start-control.mjs",start.commandId,start.requestSha256,bootId];
command("/usr/bin/env",startArgv);
const completionPath=controlRoot+"/boot-service-start-completion.json", result=JSON.parse(await readFile(completionPath,"utf8"));
const invocationId=property(unit,"InvocationID"), mainPid=Number(property(unit,"MainPID"));
assert.match(invocationId,/^(?!0{32}$)[0-9a-f]{32}$/);assert(mainPid>0);
assert.deepEqual(result,{...f.startCompletion,serviceInvocationId:invocationId,mainPid});
assert.equal(property(unit,"ActiveState"),"active");assert.equal(property(unit,"NRestarts"),"0");
assert.equal(property(unit,"StateDirectory"),"qorpera-office-events");
assert.equal(property(unit,"StateDirectoryMode"),"0700");
const eventRoot="/var/lib/qorpera-office-events",eventStat=await lstat(eventRoot);
assert(eventStat.isDirectory()&&!eventStat.isSymbolicLink());
assert.equal(eventStat.mode&0o7777,0o700);assert.equal(eventStat.uid,1100);assert.equal(eventStat.gid,1100);
for(const path of Object.values(f.receipt.layout))assert(!eventRoot.startsWith(path+'/')&&!path.startsWith(eventRoot+'/')&&path!==eventRoot);
const eventFiles=[eventRoot+"/synthetic-pending.json"],eventSnapshot=await snapshot(eventFiles);
assert.equal(eventSnapshot[0].mode&0o7777,0o600);assert.equal(eventSnapshot[0].uid,1100);
const cgroup=property(unit,"ControlGroup");assert.equal(cgroup,"/system.slice/qorpera-company-computer.service");
assert.match(await readFile("/sys/fs/cgroup"+cgroup+"/cgroup.events","utf8"),/^populated 1$/m);
const live=JSON.parse(await readFile(f.receipt.layout.workbenchRoot+"/service-proof.json","utf8"));
assert.equal(live.invocationId,invocationId);assert.equal(live.pid,mainPid);
const credentials=(await readFile("/etc/systemd/system/"+unit,"utf8")).split("\n").filter(line=>line.startsWith("LoadCredential="));
assert.equal(credentials.length,6);
assert.deepEqual(live.credentials,Object.fromEntries(credentials.map(line=>{const [id,path]=line.slice("LoadCredential=".length).split(":");return [id,f.completion.files[path.slice(path.lastIndexOf("/")+1)].sha256];})));
const completed=await snapshot([completionPath,controlRoot+"/boot-service-start-claim.json"]);
command("/usr/bin/env",startArgv);assert.deepEqual(await snapshot([completionPath,controlRoot+"/boot-service-start-claim.json"]),completed);
const nonce="00000000-0000-4000-8000-000000000202";
command("/usr/bin/env",[...startArgv,nonce]);
assert.deepEqual(JSON.parse(await readFile(controlRoot+"/boot-service-inspection-"+nonce+".json","utf8")),{schema:"qorpera.office-boot-service-inspection/v1",inspectionId:nonce,start:result});
assert.equal(property(prep,"InvocationID"),"");assert.equal(property(prep,"MainPID"),"0");
assert.deepEqual(await snapshot(preserved),before);assert.deepEqual(await snapshot(newFiles),installed);
const nativeCredential=await readFile(directory+"/credentials/native");
await unlink(directory+"/credentials/native");
for(const args of [startArgv,[...startArgv,"00000000-0000-4000-8000-000000000203"]]){
 const refused=spawnSync("/usr/bin/env",args,{encoding:"utf8",timeout:120000});assert.equal(refused.status,1,refused.stderr);
}
assert.equal(property(unit,"InvocationID"),invocationId);assert.equal(property(unit,"MainPID"),String(mainPid));
assert.deepEqual(await snapshot([completionPath,controlRoot+"/boot-service-start-claim.json"]),completed);
assert.deepEqual(await snapshot(preserved),before);
// Stop remains available with a missing secret credential. It uses the
// current boot's public configuration, preserving the prior shutdown archive.
const stopRequest={schema:"qorpera.office-service-stop-request/v1",startCompletionSha256:hash(await readFile(completionPath)),revocation:{schema:"qorpera.office-lifecycle-transition/v1",state:"draining",revocationRevision:6,requestedAtMs:Date.now(),drains:[],request:{...f.input.bootIntent.request.predecessor,action:"service_restart",transitionId:"00000000-0000-4000-8000-000000000301",activationId:result.activationId,startup:{...f.input.bootIntent.request.predecessor.startup,bootId,configurationSha256:result.configurationSha256,serviceInvocationId:invocationId}}}};
const stop={commandId:"00000000-0000-4000-8000-000000000302",requestSha256:hash(encode(stopRequest)),bootId};
await writeFile(controlRoot+"/service-stop-incoming-"+stop.requestSha256+".json",encode(stopRequest),{mode:0o400});
const stopArgv=["-i","/usr/bin/node","/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs",stop.commandId,stop.requestSha256,bootId];
command("/usr/bin/env",stopArgv);
assert.equal(property(unit,"MainPID"),"0");assert.equal(property(unit,"ActiveState"),"inactive");
await assert.rejects(readFile("/sys/fs/cgroup"+cgroup+"/cgroup.events"),{code:"ENOENT"});
const stoppedPath=controlRoot+"/service-stop-completion-"+result.activationId+".json", stopped=JSON.parse(await readFile(stoppedPath,"utf8"));
assert.equal(stopped.fromServiceInvocationId,invocationId);assert.equal(stopped.startCompletionSha256,stopRequest.startCompletionSha256);assert.equal(stopped.cgroupState,"absent");
const historyDirectory="/etc/qorpera-office/history/"+bootId+"/"+result.activationId,history=JSON.parse(await readFile(historyDirectory+"/manifest.json","utf8"));
assert.equal(history.completionPath,stoppedPath);assert.equal(history.entries.length,10);
assert(history.entries.some(entry=>entry.path===directory+"/credentials/config.json"));
assert(history.entries.every(entry=>!/credentials\/(?!config\.json)|boot-configuration-incoming|preparation\.json/.test(entry.path)));
const stoppedFiles=[stoppedPath,controlRoot+"/service-stop-claim-"+result.activationId+".json",historyDirectory+"/claim.json",historyDirectory+"/manifest.json",...history.entries.map(entry=>historyDirectory+"/"+entry.sha256+".json")],stopSnapshot=await snapshot(stoppedFiles);
command("/usr/bin/env",stopArgv);assert.deepEqual(await snapshot(stoppedFiles),stopSnapshot);
const stopNonce="00000000-0000-4000-8000-000000000390";
command("/usr/bin/env",[...stopArgv,stopNonce]);
assert.deepEqual(JSON.parse(await readFile(controlRoot+"/service-stop-inspection-"+stopNonce+".json","utf8")).stop,stopped);
assert.equal(spawnSync("/usr/bin/env",startArgv,{encoding:"utf8",timeout:120000}).status,1);
assert.equal(property(unit,"MainPID"),"0");assert.equal(property(prep,"InvocationID"),"");
assert.deepEqual(await snapshot(preserved),before);assert.deepEqual(await snapshot([completionPath,controlRoot+"/boot-service-start-claim.json"]),completed);
// The SQL acknowledgements below are synthetic; each stop, nonce inspection,
// successor claim, service invocation and cgroup measurement is produced by
// the packaged root controls against the actual systemd manager.
await writeFile(directory+"/credentials/native",nativeCredential,{mode:0o400});nativeCredential.fill(0);
let prior=result, priorStop=stopRequest, priorStopped=stopped, priorStoppedPath=stoppedPath, priorInspection=JSON.parse(await readFile(controlRoot+"/service-stop-inspection-"+stopNonce+".json","utf8"));
const invocationIds=new Set([result.serviceInvocationId]), restartRecords=[];
const fixtureId=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const retainedBootFiles=[directory+"/adoption.json",directory+"/configuration-claim.json",directory+"/configuration-completion.json",directory+"/credentials/config.json",completionPath,controlRoot+"/boot-service-start-claim.json"];
const retainedBootSnapshot=await snapshot(retainedBootFiles);
for(let serial=1;serial<=2;serial++){
 const base=(f.input.bootIntent.request.predecessor.startup.bootId!==f.original.bootId?1000:400)+serial*10, activationId=fixtureId(base);
 const packet={schema:"qorpera.office-boot-service-restart-request/v1",origin:f.request,successor:{schema:"qorpera.office-service-successor/v1",request:{schema:"qorpera.office-service-successor-request/v1",predecessor:priorStop.revocation.request,attestation:{...f.request.successor.request.attestation,activationId}},state:"prepared",serviceInvocationId:null,readinessFresh:false,stopAcknowledgedAtMs:Date.now(),officeRevision:10+serial,privacyVersion:0,validForMs:5000},stop:priorStop,acknowledgement:{schema:"qorpera.office-service-stop-acknowledgement/v1",state:"stopped",request:priorStop.revocation.request,inspection:priorInspection,acknowledgedAtMs:0},stopCompletionSha256:hash(await readFile(priorStoppedPath))};
 packet.acknowledgement.acknowledgedAtMs=packet.successor.stopAcknowledgedAtMs;
 const restartCommand={commandId:fixtureId(base+4),requestSha256:hash(encode(packet)),bootId};
 await writeFile(controlRoot+"/boot-service-restart-incoming-"+restartCommand.requestSha256+".json",encode(packet),{mode:0o400});
 const restartArgv=["-i","/usr/bin/node","/opt/qorpera-office/qorpera-company-computer-boot-service-restart-control.mjs",restartCommand.commandId,restartCommand.requestSha256,bootId];
 command("/usr/bin/env",restartArgv);
 const path=controlRoot+"/boot-service-restart-completion-"+activationId+".json",completion=JSON.parse(await readFile(path,"utf8"));
 assert.equal(completion.schema,"qorpera.office-boot-service-restart-completion/v1");
 assert.equal(completion.bootIntentId,result.bootIntentId);assert.equal(completion.originActivationId,result.activationId);assert.equal(completion.activationId,activationId);
 assert.equal(completion.configurationSha256,result.configurationSha256);assert.equal(completion.configurationCompletionSha256,result.configurationCompletionSha256);
 assert.equal(completion.serviceInvocationId,property(unit,"InvocationID"));assert.equal(completion.mainPid,Number(property(unit,"MainPID")));assert.equal(property(unit,"NRestarts"),"0");
 assert(!invocationIds.has(completion.serviceInvocationId));invocationIds.add(completion.serviceInvocationId);
 assert.match(await readFile("/sys/fs/cgroup"+cgroup+"/cgroup.events","utf8"),/^populated 1$/m);
 const proof=JSON.parse(await readFile(f.receipt.layout.workbenchRoot+"/service-proof.json","utf8"));assert.equal(proof.invocationId,completion.serviceInvocationId);assert.deepEqual(proof.credentials,live.credentials);
 assert.deepEqual(await snapshot(eventFiles),eventSnapshot);
	const claimPath=controlRoot+"/service-successor-"+prior.activationId+".json", immutable=await snapshot([path,claimPath]);
 command("/usr/bin/env",restartArgv);command("/usr/bin/env",[...restartArgv,fixtureId(base+5)]);
 assert.deepEqual(await snapshot([path,claimPath]),immutable);
 assert.deepEqual(JSON.parse(await readFile(controlRoot+"/boot-service-restart-inspection-"+fixtureId(base+5)+".json","utf8")).start,completion);
 // Stop this successor using its actual typed start completion, then allow
 // the following iteration to prepare another explicit successor.
 const nextStop={...priorStop,startCompletionSha256:hash(await readFile(path)),revocation:{...priorStop.revocation,requestedAtMs:Date.now(),request:{...priorStop.revocation.request,transitionId:fixtureId(base+6),activationId,startup:{...priorStop.revocation.request.startup,serviceInvocationId:completion.serviceInvocationId}}}};
 const nextStopCommand={commandId:fixtureId(base+7),requestSha256:hash(encode(nextStop)),bootId};
 await writeFile(controlRoot+"/service-stop-incoming-"+nextStopCommand.requestSha256+".json",encode(nextStop),{mode:0o400});
 const nextStopArgv=["-i","/usr/bin/node","/opt/qorpera-office/qorpera-company-computer-service-stop-control.mjs",nextStopCommand.commandId,nextStopCommand.requestSha256,bootId];
 command("/usr/bin/env",nextStopArgv);command("/usr/bin/env",nextStopArgv);command("/usr/bin/env",[...nextStopArgv,fixtureId(base+8)]);
 assert.equal(property(unit,"MainPID"),"0");assert.equal(property(unit,"ActiveState"),"inactive");await assert.rejects(readFile("/sys/fs/cgroup"+cgroup+"/cgroup.events"),{code:"ENOENT"});
 const nextStoppedPath=controlRoot+"/service-stop-completion-"+activationId+".json", nextStopped=JSON.parse(await readFile(nextStoppedPath,"utf8")), nextInspection=JSON.parse(await readFile(controlRoot+"/service-stop-inspection-"+fixtureId(base+8)+".json","utf8"));
 assert.equal(nextStopped.fromServiceInvocationId,completion.serviceInvocationId);assert.deepEqual(nextInspection.stop,nextStopped);
 assert.equal(spawnSync("/usr/bin/env",restartArgv,{encoding:"utf8",timeout:120000}).status,1);
 assert.deepEqual(await snapshot(retainedBootFiles),retainedBootSnapshot);assert.deepEqual(await snapshot(preserved),before);assert.deepEqual(await snapshot(stoppedFiles),stopSnapshot);
 restartRecords.push(...immutable);assert.deepEqual(await snapshot(restartRecords.map(item=>item.path)),restartRecords);
 prior=completion;priorStop=nextStop;priorStopped=nextStopped;priorStoppedPath=nextStoppedPath;priorInspection=nextInspection;
}
assert.equal(invocationIds.size,3);assert.equal(property(prep,"InvocationID"),"");
assert.deepEqual(await snapshot(eventFiles),eventSnapshot);
const finalEventStat=await lstat(eventRoot);assert.equal(finalEventStat.ino,eventStat.ino);assert.equal(finalEventStat.mode,eventStat.mode);assert.equal(finalEventStat.uid,eventStat.uid);
console.log(JSON.stringify({schema:"qorpera.office-screen-custody-systemd-proof/v1",actualSystemd:true,stateDirectory:eventRoot,mode:"0700",owner:1100,disjointFromWorkbench:true,serviceCanFsync:true,retainedAcrossExplicitRestarts:2,originalFileInodeAndBytesPreserved:true,eventContents:"synthetic",actualScreenOutbox:false}));
console.log(JSON.stringify({schema:"qorpera.office-boot-service-start-systemd-proof/v1",actualSystemd:true,laterBootPredecessor:f.input.bootIntent.request.predecessor.startup.bootId!==f.original.bootId,actualPackagedRootHelper:true,actualKernelFlock:true,actualCgroup:true,actualPersistentFilesystem:mount.filesystem,loadedBootCredentials:6,starts:3,explicitSameBootRestarts:2,allRestartsStopped:true,originalBootActivationUnchanged:true,replayPreservedInvocation:true,freshInspection:true,missingAcknowledgedCredentialRefused:true,stoppedAfterNewBoot:true,stopWithMissingSecretCredential:true,stopReplayAndFreshInspection:true,stoppedStartReplayRefused:true,firstStopArchivePublicFiles:history.entries.length,originalRecordsPreserved:before.length,preparationNeverStarted:true,syntheticOrdinaryWorkload:true,syntheticPriorBootAndSqlAndVm:true,realKvm:false,realNas:false,deployed:false,packageManifestSha256:hash(manifest)}));
