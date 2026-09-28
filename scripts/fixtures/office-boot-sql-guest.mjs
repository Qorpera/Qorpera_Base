// Disposable current-boot root bridge. Prior boot/copy and ordinary workload
// are fixtures; kernel identity, mount custody and packaged controls are real.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod,chown,cp,lstat,mkdir,open,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {parseRecoveryDirectoryMount} from '/fixture/mount.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:120000});assert.equal(r.status,0,r.stdout+' '+r.stderr);return r.stdout.trim();};
const ctl=(...args)=>run('/usr/bin/systemctl',args),unit='qorpera-company-computer.service',prep='qorpera-company-computer-preparation.service';
const property=(name,key)=>ctl('show',name,'--property='+key,'--value');
const idle=()=>{for(const name of [unit,prep]){assert.equal(property(name,'ActiveState'),'inactive');assert.equal(property(name,'InvocationID'),'');assert.equal(property(name,'MainPID'),'0');}};
const root='/run/qorpera-office-preparation',base='/opt/qorpera-office',pkg='/run/office-boot-sql-package';
await cp('/fixture/package',pkg,{recursive:true});await chmod(pkg,0o755);
// A copy keeps each file's owner: the invoking user on a Linux Docker host (Docker Desktop shows
// mounted files as root). The installer requires root-owned staging, so every file is chowned.
const manifest=await readFile(pkg+'/manifest.json');
for(const artifact of JSON.parse(manifest).artifacts){await chown(pkg+'/'+artifact.file,0,0);await chmod(pkg+'/'+artifact.file,0o444);}
await chown(pkg+'/manifest.json',0,0);await chmod(pkg+'/manifest.json',0o444);
const installer=pkg+'/qorpera-office-image-install.cjs',dependencies=JSON.parse(run('/usr/bin/node',[installer,'--measure-dependencies']));
await writeFile('/run/office-boot-sql-spec.json',JSON.stringify({schema:'qorpera.office-image-installation/v1',packageRoot:pkg,packageManifestSha256:hash(manifest),uid:1100,gid:1100,architecture:process.arch,dependencies}),{mode:0o444});
run('/usr/bin/node',[installer,'--apply','--spec','/run/office-boot-sql-spec.json']);idle();
run('mount',['--bind','/fixture/workbench','/var/lib/qorpera-office']);
const descriptor=await open('/var/lib/qorpera-office','r');let mount;
try{mount=parseRecoveryDirectoryMount(await readFile('/proc/self/mountinfo','utf8'),await readFile(`/proc/self/fdinfo/${descriptor.fd}`,'utf8'));}finally{await descriptor.close();}
assert.notEqual(mount.filesystem,'tmpfs');assert.equal(mount.mountPoint,'/var/lib/qorpera-office');
const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','/run/office-key','-out','/run/office-cert','-days','1','-subj','/CN=office.invalid']);
const historical=new Map(),current=new Map(),invocations=new Set(),counts={};let seeded=false,processes,work,descendantsStopped=0;
const original=Buffer.from('retained edited company work\n');
const allowed=path=>typeof path==='string'&&!path.includes('..')&&(
 /^\/run\/qorpera-office-preparation\/[a-z0-9-]+\.json$/.test(path)||path===root+'/control.lock'||
 /^\/etc\/qorpera-office\/(?:preparation|adoption)\.json$/.test(path)||
 /^\/etc\/qorpera-office\/credentials\/config\.json$/.test(path)||
 /^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/(?:adoption\.json|configuration-(?:claim|completion)\.json|credentials\/(?:config\.json|registry|native|objects|tls-cert\.pem|tls-key\.pem))$/.test(path)||
 /^\/etc\/qorpera-office\/history\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/(?:claim|manifest|[0-9a-f]{64})\.json$/.test(path));
const retain=async(path,records)=>{const stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink());const value={ino:stat.ino,mode:stat.mode&0o7777,uid:stat.uid,gid:stat.gid,sha256:hash(await readFile(path))};assert.equal(value.uid,0);assert.equal(value.gid,0);if(records.has(path))assert.deepEqual(value,records.get(path),path);else records.set(path,value);};
const walk=async path=>{let names;try{names=await readdir(path);}catch(e){if(e.code==='ENOENT')return;throw e;}for(const name of names){const p=path+'/'+name,s=await lstat(p);assert(!s.isSymbolicLink());if(s.isDirectory())await walk(p);else await retain(p,current);}};
async function snapshot(){
 for(const path of historical.keys())await retain(path,historical);
 for(const path of current.keys())await retain(path,current);
 for(const name of await readdir(root))if(/(?:claim|completion|successor-).*\.json$/.test(name))await retain(root+'/'+name,current);
 await walk('/etc/qorpera-office/boots/'+bootId.replaceAll('-',''));
 await walk('/etc/qorpera-office/history/'+bootId);
 if(seeded){assert((await readFile(work)).equals(original));assert.equal(property(prep,'InvocationID'),'');}
}
console.log(JSON.stringify({ready:true,bootId,mount,uid:1100,tlsCert:await readFile('/run/office-cert','utf8'),tlsKey:await readFile('/run/office-key','utf8')}));
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 let request;
 try{
  request=JSON.parse(line);assert(Number.isSafeInteger(request.id));let result;
  if(request.method==='seed'){
   assert(!seeded);idle();assert(Array.isArray(request.files));
   for(const {path,content,mode}of request.files){
    assert(allowed(path)&&path.startsWith('/etc/qorpera-office/')&&!path.includes('/boots/'));assert([0o444,0o400,0o600].includes(mode));
    await mkdir(dirname(path),{recursive:true,mode:path.includes('/history/')||path.includes('/credentials/')?0o700:0o755});
    const bytes=Buffer.from(content,'base64');assert(bytes.length<=16*1024**2);await writeFile(path,bytes,{mode,flag:'wx'});await retain(path,historical);
   }
   const preparation=JSON.parse(await readFile('/etc/qorpera-office/preparation.json','utf8'));
   assert.notEqual(preparation.bootId,bootId);assert.equal(preparation.uid,1100);assert.equal(preparation.gid,1100);assert.deepEqual(preparation.workbenchMount,{filesystem:mount.filesystem,source:mount.source,root:mount.root,mountPoint:mount.mountPoint});
   const receipt=JSON.parse(await readFile('/etc/qorpera-office/adoption.json','utf8'));
   for(const path of [dirname(receipt.layout.workbenchRoot),...Object.values(receipt.layout)]){assert(path.startsWith('/var/lib/qorpera-office/.qorpera-adopted-'));await mkdir(path,{recursive:true,mode:0o700});await chown(path,1100,1100);}
   work=receipt.layout.workbenchRoot+'/retained-work';processes=receipt.layout.workbenchRoot+'/processes.json';await writeFile(work,original,{mode:0o600});await chown(work,1100,1100);
   // Only the ordinary workload entry is replaced; every root control and unit
   // remains the packaged artifact. The probe has a detached child to stop.
   await writeFile(base+'/qorpera-company-computer-service.mjs',`import{spawn}from'node:child_process';import{writeFileSync,readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';
const credentials=Object.fromEntries(readdirSync(process.env.CREDENTIALS_DIRECTORY).map(n=>[n,createHash('sha256').update(readFileSync(process.env.CREDENTIALS_DIRECTORY+'/'+n)).digest('hex')]));const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});writeFileSync(${JSON.stringify(processes)},JSON.stringify({main:process.pid,child:child.pid,credentials}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`);await chmod(base+'/qorpera-company-computer-service.mjs',0o444);
   seeded=true;await snapshot();result=null;
  }else if(request.method==='stage'){
   assert(seeded);const {path,content}=request;assert(allowed(path));const bytes=Buffer.from(content,'base64');assert(bytes.length<=16*1024**2&&path.startsWith(root+'/')&&path.endsWith('incoming-'+hash(bytes)+'.json'));
   let fd;try{fd=await open(path,'wx',0o400);}catch(e){if(e.code!=='EEXIST')throw e;assert((await readFile(path)).equals(bytes));}if(fd)try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}result=null;
  }else if(request.method==='read'){
   const {path}=request;assert(allowed(path));let stat;try{stat=await lstat(path);}catch(e){if(e.code!=='ENOENT')throw e;}
   if(!stat)result=null;else{assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=16*1024**2);result={content:(await readFile(path)).toString('base64'),uid:stat.uid,gid:stat.gid,mode:'0'+(stat.mode&0o7777).toString(8)};}
  }else if(request.method==='execute'){
   assert(seeded);const {argv}=request;assert(Array.isArray(argv)&&[7,8].includes(argv.length));assert.deepEqual(argv.slice(0,3),['/usr/bin/env','-i','/usr/bin/node']);
   const match=/^\/opt\/qorpera-office\/qorpera-company-computer-(boot-configuration|boot-service-start|boot-service-restart|service-stop)-control\.mjs$/.exec(argv[3]);assert(match);assert(/^[0-9a-f-]{36}$/.test(argv[4])&&/^[0-9a-f]{64}$/.test(argv[5])&&argv[6]===bootId);if(argv.length===8)assert(/^[0-9a-f-]{36}$/.test(argv[7]));
   const key=match[1]+(argv.length===8?'-inspect':'');const before=match[1]==='service-stop'&&argv.length===7?JSON.parse(await readFile(processes,'utf8')):undefined;
   run(argv[0],argv.slice(1));counts[key]=(counts[key]??0)+1;
   if(before){assert.equal(property(unit,'MainPID'),'0');assert.equal(property(unit,'ActiveState'),'inactive');for(const pid of [before.main,before.child]){for(let i=0;i<40;i++){try{process.kill(pid,0);}catch{break;}await delay(25);}assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}descendantsStopped++;}
   if(['boot-service-start','boot-service-restart'].includes(match[1])&&argv.length===7){
    assert.equal(property(unit,'ActiveState'),'active');const invocation=property(unit,'InvocationID');assert(!invocations.has(invocation));invocations.add(invocation);
    assert.match(await readFile('/sys/fs/cgroup'+property(unit,'ControlGroup')+'/cgroup.events','utf8'),/^populated 1$/m);
    const proof=JSON.parse(await readFile(processes,'utf8'));assert.equal(proof.main,Number(property(unit,'MainPID')));assert.equal(Object.keys(proof.credentials).length,6);
    for(const [name,file]of [['config','config.json'],['registry','registry'],['native','native'],['objects','objects'],['tls-cert','tls-cert.pem'],['tls-key','tls-key.pem']])assert.equal(proof.credentials['qorpera-office-'+name],hash(await readFile('/etc/qorpera-office/boots/'+bootId.replaceAll('-','')+'/credentials/'+file)));
   }
   await snapshot();result=null;
  }else if(request.method==='proof'){
   assert(seeded);await snapshot();result={schema:'qorpera.office-boot-sql-systemd-proof/v1',bootId,mount,counts,invocations:[...invocations],descendantsStopped,historicalRecords:historical.size,currentRecords:current.size,serviceState:property(unit,'ActiveState'),preparationNeverStarted:property(prep,'InvocationID')==='',packageManifestSha256:hash(manifest),actualSystemd:true,actualKernelFlock:true,actualCgroup:true,retainedWorkPreserved:true,loadedBootCredentials:6,ordinaryWorkload:'synthetic',priorBootAndCopy:'synthetic',realKvm:false,realNas:false};
  }else throw new Error('Unknown boot guest method');
  console.log(JSON.stringify({id:request.id,result}));
 }catch(error){console.log(JSON.stringify({id:request?.id,error:String(error)}));}
}
