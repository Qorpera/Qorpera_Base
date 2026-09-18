// Test-only JSON-lines bridge inside the marker-owned disposable systemd guest.
// No host files or real credentials are writable through this bridge.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod,chown,lstat,open,readFile,readdir,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
const root='/run/qorpera-office-preparation',base='/opt/qorpera-office',unit='qorpera-company-computer.service';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(file,args,timeout=90000)=>{const result=spawnSync(file,args,{encoding:'utf8',timeout,maxBuffer:1024**2});assert.equal(result.status,0,result.stdout+' '+result.stderr);return result.stdout.trim();};
const load=async path=>JSON.parse(await readFile(path,'utf8'));
assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);
const installed=run('/usr/bin/node',['/fixture/install-check.mjs'],120000);
const installation=JSON.parse(installed.split('\n').find(line=>line.startsWith('GUEST_IMAGE_INSTALL_PROOF=')).split('=',2)[1]);
run('/usr/bin/mount',['-t','tmpfs','-o','nodev,nosuid,mode=0700,uid=1100,gid=1100,size=16m','tmpfs','/var/lib/qorpera-office']);
const work='/var/lib/qorpera-office/retained-work',original=Buffer.from('retained work across SQL-authorized service restarts\n');
await writeFile(work,original,{mode:0o600});await chown(work,1100,1100);
// The retained preparation result comes from an actual oneshot invocation.
// Inventory/copy measurements and ordinary workload are explicitly synthetic.
await writeFile(base+'/qorpera-company-computer-preparation.mjs',`import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
const bytes=readFileSync('/etc/qorpera-office/preparation.json'),r=JSON.parse(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
console.log(JSON.stringify({schema:'qorpera.office-guest-preparation-result/v1',state:'prepared',scope:r.scope,computerGeneration:r.computerGeneration,allocationId:r.allocationId,instanceSha256:r.instanceSha256,imageSha256:r.imageSha256,bootstrapSha256:r.bootstrapSha256,bootId:r.bootId,copy:r.copy,workbenchMount:r.workbenchMount,requestSha256:hash(bytes),contentSha256:hash(JSON.stringify(r.entries)),observationSha256:'a'.repeat(64),entries:r.entries.length,totalBytes:r.entries.reduce((n,e)=>n+e.bytes,0),invocationId:process.env.INVOCATION_ID}));\n`);
await chmod(base+'/qorpera-company-computer-preparation.mjs',0o444);
await writeFile(base+'/qorpera-company-computer-service.mjs',`import{spawn}from'node:child_process';import{writeFileSync,readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';
const credentials=Object.fromEntries(readdirSync(process.env.CREDENTIALS_DIRECTORY).map(name=>[name,createHash('sha256').update(readFileSync(process.env.CREDENTIALS_DIRECTORY+'/'+name)).digest('hex')]));
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
writeFileSync('/var/lib/qorpera-office/processes.json',JSON.stringify({main:process.pid,child:child.pid,credentials}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`);
await chmod(base+'/qorpera-company-computer-service.mjs',0o444);
const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
const counts={},bootCredentials=new Map(),history=new Map(),durableHistory=new Map(),durableArchives=new Set(),invocations=new Set();let descendantsStopped=0;
const observe=()=>JSON.parse(run('/usr/bin/node',['/fixture/consumer.mjs'],15000));
const allowed=path=>typeof path==='string'&&!path.includes('..')&&(
 /^\/run\/qorpera-office-preparation\/[a-z0-9-]+\.json$/.test(path)||path===root+'/control.lock'||
 path==='/etc/qorpera-office/adoption.json'||/^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/credentials\/(?:config\.json|registry|native|objects|tls-cert\.pem|tls-key\.pem)$/.test(path)||/^\/etc\/qorpera-office\/credentials\/(?:config\.json|registry|native|objects|tls-cert\.pem|tls-key\.pem)$/.test(path));
async function snapshot(){
 const retain=async(path,records)=>{
  const stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink());
  const value={ino:stat.ino,sha256:hash(await readFile(path)),mode:stat.mode&0o7777,uid:stat.uid,gid:stat.gid};
  if(records.has(path))assert.deepEqual(value,records.get(path),path);else records.set(path,value);
 };
 const bootRoot='/etc/qorpera-office/boots/'+bootId.replaceAll('-','')+'/credentials';
 let credentialFiles=[];try{credentialFiles=await readdir(bootRoot);}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const name of credentialFiles)await retain(bootRoot+'/'+name,bootCredentials);
 for(const path of history.keys())await retain(path,history);
 for(const name of await readdir(root)){
  if(!/(?:claim|completion|successor-).*\.json$/.test(name))continue;
  await retain(root+'/'+name,history);
 }
 for(const path of durableHistory.keys())await retain(path,durableHistory);
 const archives='/etc/qorpera-office/history/'+bootId;
 let activations=[];try{activations=await readdir(archives);}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const activation of activations){
  assert(/^[0-9a-f-]{36}$/.test(activation));const directory=archives+'/'+activation;
  for(const path of ['/etc/qorpera-office/history',archives,directory]){const stat=await lstat(path);assert(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(stat.mode&0o7777,0o700);assert.equal(stat.uid,0);assert.equal(stat.gid,0);}
  const manifestBytes=await readFile(directory+'/manifest.json'),manifest=JSON.parse(manifestBytes);
  assert.equal(manifest.schema,'qorpera.office-stop-history/v1');assert.equal(manifest.activationId,activation);assert.equal(manifest.command.bootId,bootId);
  assert((await readFile(directory+'/claim.json')).equals(manifestBytes));
  assert(manifest.entries.some(entry=>entry.path===manifest.completionPath));
  for(const entry of manifest.entries){
   assert(/^[0-9a-f]{64}$/.test(entry.sha256));const bytes=await readFile(directory+'/'+entry.sha256+'.json');
   assert.equal(bytes.length,entry.bytes);assert.equal(hash(bytes),entry.sha256);
   assert((await readFile(entry.path)).equals(bytes),'archive source differs: '+entry.path);
  }
  for(const name of await readdir(directory)){
   assert(/^(?:claim|manifest|[0-9a-f]{64})\.json$/.test(name));const path=directory+'/'+name;
   await retain(path,durableHistory);const value=durableHistory.get(path);assert.equal(value.mode,0o600);assert.equal(value.uid,0);assert.equal(value.gid,0);
  }
  durableArchives.add(activation);
 }
 assert((await readFile(work)).equals(original));
}
console.log(JSON.stringify({ready:true,bootId,installation}));
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 let request;
 try{
  request=JSON.parse(line);assert(Number.isSafeInteger(request.id));let result;
  if(request.method==='stage'){
   const {path,content}=request;assert(allowed(path));const bytes=Buffer.from(content,'base64');assert(bytes.length<=16*1024**2);
   assert(path.endsWith('incoming-'+hash(bytes)+'.json'));
   let file;try{file=await open(path,'wx',0o400);}catch(error){if(error.code!=='EEXIST')throw error;assert((await readFile(path)).equals(bytes));}
   if(file)try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   result=null;
  }else if(request.method==='read'){
   const {path}=request;assert(allowed(path));let stat;
   try{stat=await lstat(path);}catch(error){if(error.code!=='ENOENT')throw error;}
   if(!stat)result=null;else{assert(stat.isFile()&&!stat.isSymbolicLink());assert(stat.size<=16*1024**2);result={content:(await readFile(path)).toString('base64'),uid:stat.uid,gid:stat.gid,mode:'0'+(stat.mode&0o7777).toString(8)};}
  }else if(request.method==='execute'){
   const {argv}=request;assert(Array.isArray(argv)&&[7,8].includes(argv.length));
   assert.deepEqual(argv.slice(0,3),['/usr/bin/env','-i','/usr/bin/node']);
   const match=/^\/opt\/qorpera-office\/qorpera-company-computer-(preparation|configuration|service-start|service-stop|service-restart)-control\.mjs$/.exec(argv[3]);assert(match);
   const key=match[1]+(argv.length===8?'-inspect':'');
   assert(/^[0-9a-f-]{36}$/.test(argv[4])&&/^[0-9a-f]{64}$/.test(argv[5])&&argv[6]===bootId);
   if(argv.length===8)assert(/^[0-9a-f-]{36}$/.test(argv[7]));
   const before=match[1]==='service-stop'&&argv.length===7?await load('/var/lib/qorpera-office/processes.json'):null;
   run(argv[0],argv.slice(1));counts[key]=(counts[key]??0)+1;
   if(before){
    const state=observe();assert(['empty','absent'].includes(state.cgroupState));assert.equal(state.service.mainPid,0);
    for(const pid of [before.main,before.child]){for(let i=0;i<40;i++){try{process.kill(pid,0);}catch{break;}await delay(25);}assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
    descendantsStopped++;
   }
   if(['service-start','service-restart'].includes(match[1])&&argv.length===7){const state=observe();assert.equal(state.service.activeState,'active');assert.equal(state.cgroupState,'populated');assert(!invocations.has(state.service.invocationId));invocations.add(state.service.invocationId);}
   if(['service-start','service-restart'].includes(match[1])&&argv.length===7){
    const loaded=(await load('/var/lib/qorpera-office/processes.json')).credentials;
    const pairs=[['config','config.json'],['registry','registry'],['native','native'],['objects','objects'],['tls-cert','tls-cert.pem'],['tls-key','tls-key.pem']];
    assert.equal(Object.keys(loaded).length,6);
    for(const [name,file]of pairs)assert.equal(loaded['qorpera-office-'+name],hash(await readFile('/etc/qorpera-office/boots/'+bootId.replaceAll('-','')+'/credentials/'+file)));
   }
   await snapshot();result=null;
  }else if(request.method==='proof'){
   await snapshot();result={schema:'qorpera.office-sql-systemd-guest-proof/v1',bootId,counts,invocations:[...invocations],descendantsStopped,historyRecords:history.size,bootCredentialRecords:bootCredentials.size,loadedBootCredentialChecks:invocations.size,durableStopArchives:durableArchives.size,durableHistoryRecords:durableHistory.size,workbenchRetained:true,actualSystemd:true,actualKernelCgroup:true,actualKernelFlock:true,service:observe(),preparationInventory:'synthetic',ordinaryWorkload:'synthetic',realKvm:false,realNas:false,installation};
  }else throw new Error('Unknown disposable guest command');
  console.log(JSON.stringify({id:request.id,result}));
 }catch(error){console.log(JSON.stringify({id:request?.id,error:String(error)}));}
}
