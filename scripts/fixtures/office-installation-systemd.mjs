import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod,chown,cp,lstat,mkdir,readFile,readdir,readlink,rename,rm,writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const {officePhysicalFixture,lxdOfficePhysicalPolicySha256}=createRequire(import.meta.url)('/fixture/physical.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
const exec=(file,args,timeout=10000)=>spawnSync(file,args,{encoding:'utf8',timeout});
const ok=(file,args,timeout)=>{const r=exec(file,args,timeout);assert.equal(r.status,0,`${file} ${args.join(' ')}: ${r.stderr} ${r.stdout}`);return r.stdout.trim();};
const ctl=(...args)=>ok('/usr/bin/systemctl',args,95000);
const prop=(name,key)=>ctl('show',name,'--property='+key,'--value');
const unit='qorpera-office-provider.service';
const mount='/srv/office-install-journal';
const journal=mount+'/%n-${HOME}-"journal"';
const lock=journal+'/adoption.lock';
const root='/run/office-install-input';
const installer=root+'/package/qorpera-office-provider-install.cjs';
const specPath=root+'/spec.json';
const output='/opt/qorpera/office-provider';
const config='/etc/qorpera/office-provider';
let loop,server,requests=[],serverErrors=[],registryUnavailable=false;const checks=[];
const check=name=>{checks.push(name);console.log('PASS '+name);};
async function until(fn,label,ms=15000){const start=performance.now();while(!await fn()){if(performance.now()-start>=ms)assert.fail(label+' '+exec('/usr/bin/systemctl',['status',unit,'--no-pager']).stdout);await delay(50);}}
function install(stage='--apply',success=true,code){const r=exec('/usr/bin/node',['--jitless','--disable-proto=throw','--disallow-code-generation-from-strings',installer,stage,'--spec',specPath],90000);assert.equal(r.status,success?0:1,JSON.stringify({error:String(r.error),signal:r.signal})+' '+r.stdout+' '+r.stderr);if(code)assert(r.stderr.includes(code),r.stderr);return r;}
const exists=async p=>!!await lstat(p).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
async function snapshot(){const receipt=JSON.parse(await readFile(output+'/installation.json','utf8'));return Promise.all([...receipt.files.map(f=>f.path),output+'/installation.json',lock].map(async p=>{const s=await lstat(p);return {p,ino:s.ino,mode:s.mode,uid:s.uid,gid:s.gid,sha256:hash(await readFile(p))};}));}
async function childInService(){const child=spawn('/usr/bin/setpriv',['--reuid=1100','--regid=1100','--clear-groups','/usr/bin/node','-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],{stdio:'ignore'});await delay(200);const cgroup=prop(unit,'ControlGroup');assert(cgroup.startsWith('/system.slice/'));await writeFile('/sys/fs/cgroup'+cgroup+'/cgroup.procs',String(child.pid));return child;}
try {
 assert.equal(process.platform,'linux');assert.equal(process.geteuid(),0);
 await mkdir(mount,{mode:0o755});
 ok('/usr/bin/mknod',['/dev/loop-control','c','10','237']);
 for(let i=0;i<64;i++)ok('/usr/bin/mknod',['/dev/loop'+i,'b','7',String(i)]);
 ok('/usr/bin/truncate',['-s','64M','/tmp/office-journal.img']);ok('/usr/sbin/mkfs.ext4',['-q','-F','/tmp/office-journal.img']);
 ok('/usr/bin/mount',['-t','ext4','-o','loop','/tmp/office-journal.img',mount]);
 loop=ok('/usr/bin/findmnt',['-n','-o','SOURCE','--target',mount]);assert.match(loop,/^\/dev\/loop\d+$/);
 assert.equal((await readFile('/sys/block/'+loop.slice(5)+'/loop/autoclear','utf8')).trim(),'1');
 // The packager creates the folder with the host umask: 0775 under Ubuntu's user default 0002.
 await mkdir(root,{mode:0o755});await cp('/fixture/package',root+'/package',{recursive:true});await chmod(root+'/package',0o755);
 for(const name of await readdir(root+'/package')){await chown(root+'/package/'+name,0,0);await chmod(root+'/package/'+name,0o444);}
 const {policy,envelope}=officePhysicalFixture(process.arch==='arm64'?'aarch64':'x86_64');
 policy.host.machineIdSha256=hash((await readFile('/etc/machine-id','utf8')).trim());policy.host.socketGid=1101;
 policy.workbench.uid=1100;policy.workbench.gid=1100;
 policy.journal={path:journal,mountPoint:mount,root:'/',filesystem:'ext4',source:loop};
 const key='synthetic-infrastructure-token-'.repeat(3);
 server=createServer({key:await readFile('/fixture/tls/key.pem'),cert:await readFile('/fixture/tls/cert.pem')},(request,response)=>{
  const chunks=[];request.on('data',c=>chunks.push(c));request.on('end',()=>{try{
   assert.equal(request.url,'/rest/v1/rpc/qorpera_runtime_office_provider_status');assert.equal(request.headers.authorization,'Bearer '+key);
   const args=JSON.parse(Buffer.concat(chunks));requests.push(args);
   if(registryUnavailable){response.writeHead(503).end('PRIVATE synthetic backend failure');return;}
   response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({schema:'qorpera.office-provider-status/v1',scope:args.p_scope,computerGeneration:policy.guest.computerGeneration,providerId:policy.guest.providerId,providerPolicySha256:args.p_provider_policy_sha256,providerVersion:1,preparationEnabled:false,officeState:'provisioning',imageSha256:policy.guest.imageFingerprint,bootstrapSha256:policy.guest.bootstrapSha256,intent:null,reservation:null}));
  }catch(e){serverErrors.push(String(e));response.writeHead(500).end();}});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const service={schema:'qorpera.lxd-office-provider-service/v1',policyPath:config+'/policy.json',provenancePath:config+'/provenance.json',planPath:config+'/review.json',registryUrl:`https://127.0.0.1:${server.address().port}`,registryCredential:{path:config+'/registry.credential',bytes:Buffer.byteLength(key),sha256:hash(key)},inventoryLimits:{maxEntries:100,maxDepth:4,maxFileBytes:1024,maxTotalBytes:4096,maxManifestBytes:65536},pollIntervalMs:1000};
 const documents={service:Buffer.from(JSON.stringify(service)),policy:Buffer.from(JSON.stringify(policy)),provenance:Buffer.from(JSON.stringify(envelope)),registry:Buffer.from(key),registryCa:await readFile('/fixture/tls/cert.pem')};
 const spec={schema:'qorpera.lxd-office-provider-installation/v1',packageRoot:root+'/package',packageManifestSha256:hash(await readFile(root+'/package/manifest.json')),providerPolicySha256:lxdOfficePhysicalPolicySha256(policy),documents:{}};
 for(const [name,bytes]of Object.entries(documents)){const path=root+'/'+name;await writeFile(path,bytes,{mode:name==='registry'?0o400:0o444});spec.documents[name]={path,bytes:bytes.length,sha256:hash(bytes)};}
 await writeFile(specPath,JSON.stringify(spec),{mode:0o444});
 install('--check');assert.equal(await exists(journal),false);assert.equal(await exists(config),false);assert.equal(await exists('/run/qorpera-office-provider-install'),false);assert.equal(exec('/usr/bin/getent',['passwd','1100']).status,2);assert.equal(requests.length,0);check('preview has no effects');
 install('--commit',false);assert.equal(await exists(journal),false);check('internal commit requires inherited kernel lock');
 await chmod(root+'/registry',0o644);install('--apply',false,'OFFICE_INSTALL_FILE_UNPROTECTED');await chmod(root+'/registry',0o400);assert.equal(await exists(journal),false);check('unsafe source credential refused');
 await writeFile(root+'/package/qorpera-office-provider.cjs',Buffer.concat([await readFile(root+'/package/qorpera-office-provider.cjs'),Buffer.from(' ')]));install('--apply',false);await writeFile(root+'/package/qorpera-office-provider.cjs',await readFile('/fixture/package/qorpera-office-provider.cjs'));check('changed artifact refused');
 const override='/etc/systemd/system/qorpera-office-.service.d';await mkdir(override);await writeFile(override+'/proof.conf','[Service]\nCapabilityBoundingSet=CAP_SYS_ADMIN\n');install('--apply',false,'OFFICE_INSTALL_UNIT_OVERRIDE');await rm(override,{recursive:true});assert.equal(await exists(journal),false);check('unloaded prefix override refused');
 install();assert.equal(prop(unit,'ActiveState'),'inactive');assert.equal(prop(unit,'UnitFileState'),'disabled');assert.equal(requests.length,0);assert.match(ok('/usr/bin/getent',['passwd','1100']),/^qorpera-office-provider:.*:1100:1100:.*:\/nonexistent:\/usr\/sbin\/nologin$/);assert.equal(ok('/usr/bin/id',['-G','qorpera-office-provider']),'1100 1101');
 const first=await snapshot();for(const f of first)if(f.p===config+'/registry.credential'){assert.equal(f.mode&0o7777,0o440);assert.equal(f.uid,0);assert.equal(f.gid,1100);}
 check('exact installation is private, disabled and inactive');
 install('--prepare',false,'OFFICE_INSTALL_KERNEL_LOCK_REQUIRED');install('--commit',false,'OFFICE_INSTALL_KERNEL_LOCK_REQUIRED');check('existing lock file alone cannot authorize internal stages');
 async function competitor(path){const child=spawn('/usr/bin/flock',['-xn','--no-fork',path,'/usr/bin/node','-e','process.stdout.write("held");setInterval(()=>{},1000);'],{stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(new Error('competing lock failed')));});return child;}
 for(const path of ['/run/qorpera-office-provider-install/install.lock',lock]){const held=await competitor(path);try{install('--apply',false,'OFFICE_INSTALL_CHILD_FAILED');assert.deepEqual(await snapshot(),first);}finally{held.kill('SIGTERM');await until(()=>held.exitCode!==null||held.signalCode!==null,'lock competitor cleanup');}}
 check('competing installation and adoption locks prevent publication');
 ctl('start',unit);await until(()=>requests.length>=2,'installed provider polling');const pid=Number(prop(unit,'MainPID'));assert(pid>1);
 const status=await readFile(`/proc/${pid}/status`,'utf8');for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+field+':\\s+0+$','m'));assert.match(status,/^NoNewPrivs:\s+1$/m);assert.match(status,/^Groups:[\t \d]*\b1102\b/m);assert.equal(await readlink(`/proc/${pid}/ns/mnt`),await readlink('/proc/1/ns/mnt'));
 const fdinfo=await Promise.all((await readdir(`/proc/${pid}/fdinfo`)).map(f=>readFile(`/proc/${pid}/fdinfo/${f}`,'utf8')));assert(fdinfo.some(s=>/^lock:.*FLOCK.*WRITE/m.test(s)));assert.equal(exec('/usr/bin/flock',['-xn',lock,'/usr/bin/true']).status,1);check('actual systemd provider polls with zero capabilities and owns exclusive existing lock');
 const diagnostics=()=>ok('/usr/bin/journalctl',['-u',unit,'--no-pager','-o','cat']).split('\n').filter(line=>line.startsWith('{"schema":"qorpera.lxd-office-provider-observation/v2"')).map(line=>JSON.parse(line));
 await until(()=>diagnostics().some(r=>r.state==='idle'),'attributed provider diagnostics');
 const observed=diagnostics().at(-1);assert.equal(observed.companyId,policy.guest.companyId);assert.equal(observed.companyComputerId,policy.guest.companyComputerId);
 assert.equal(observed.providerId,policy.guest.providerId);assert.equal(observed.providerPolicySha256,spec.providerPolicySha256);
 assert.equal(observed.machineIdSha256,policy.host.machineIdSha256);assert.equal(observed.guestPackageManifestSha256,policy.image.guestPackageManifestSha256);
 assert.equal(observed.physicalTransitionAt,null);assert.equal(observed.resourceReleaseInferred,false);assert(Date.now()-Date.parse(observed.observedAt)<10000);
 registryUnavailable=true;await until(()=>diagnostics().at(-1)?.state==='unconfirmed','typed registry failure diagnostic');
 const failed=diagnostics().at(-1);assert.equal(failed.errorCategory,'RECONCILIATION_UNCONFIRMED');assert.equal(failed.phase,null);assert.equal(failed.intentId,null);assert(!JSON.stringify(failed).includes('PRIVATE'));
 registryUnavailable=false;await until(()=>diagnostics().at(-1)?.state==='idle','registry diagnostic recovery');assert.equal(Number(prop(unit,'MainPID')),pid);
 check('packaged diagnostics retain public computer provider and software identity through registry failure and recovery');
 install('--apply',false,'OFFICE_INSTALL_SERVICE_NOT_STOPPED');assert.deepEqual(await snapshot(),first);check('running provider prevents installation');
 const before=requests.length;ctl('restart',unit);await until(()=>requests.length>before,'restart polling');const replacement=Number(prop(unit,'MainPID'));assert(replacement>1&&replacement!==pid);assert.deepEqual(await snapshot(),first);check('ordinary systemd restart preserves inode and credential custody');
 const crashChild=await childInService();const crashRequests=requests.length;process.kill(replacement,'SIGKILL');await until(()=>requests.length>crashRequests&&Number(prop(unit,'MainPID'))!==replacement,'crash replacement');await until(()=>crashChild.exitCode!==null||crashChild.signalCode!==null,'crash descendant cleanup');assert.deepEqual(await snapshot(),first);check('failure restart kills prior cgroup descendants and reacquires original lock');
 const orphan=await childInService();const stopStart=performance.now();ctl('stop',unit);await until(()=>orphan.exitCode!==null||orphan.signalCode!==null,'descendant cleanup');assert.equal(prop(unit,'ActiveState'),'inactive');assert.equal(exec('/usr/bin/flock',['-xn',lock,'/usr/bin/true']).status,0);check('mixed cgroup stop removes surviving descendant and releases lock');
 const stopMs=Math.round(performance.now()-stopStart);
 await writeFile(journal+'/retained-uncertain-operation',Buffer.from('synthetic retained evidence'),{mode:0o600});await chown(journal+'/retained-uncertain-operation',1100,1100);install();assert.deepEqual(await snapshot(),first);assert.equal(await readFile(journal+'/retained-uncertain-operation','utf8'),'synthetic retained evidence');check('inactive identical reinstall preserves retained state and all inodes');
 ctl('reset-failed',unit);await rename(lock,lock+'.preserved');ctl('start',unit);await delay(800);assert.equal(await exists(lock),false);assert.notEqual(prop(unit,'SubState'),'running');ctl('stop',unit);ctl('reset-failed',unit);install('--apply',false,'OFFICE_INSTALL_JOURNAL_LOCK_MISSING');await rename(lock+'.preserved',lock);assert.deepEqual(await snapshot(),first);check('missing lock is never recreated for retained journal');
 await chmod(config+'/registry.credential',0o444);install('--apply',false,'OFFICE_INSTALL_EXISTING_FILES_DIFFER');await chmod(config+'/registry.credential',0o440);check('changed installed credential custody refused');
 await rename(output+'/qorpera-office-provider.cjs',output+'/qorpera-office-provider.cjs.preserved');install('--apply',false,'OFFICE_INSTALL_STATE_REQUIRES_RECOVERY');await rename(output+'/qorpera-office-provider.cjs.preserved',output+'/qorpera-office-provider.cjs');assert.deepEqual(await snapshot(),first);check('partial retained installation requires recovery');
 await mkdir('/etc/systemd/system/'+unit+'.d');await writeFile('/etc/systemd/system/'+unit+'.d/proof.conf','[Service]\nMemoryDenyWriteExecute=no\n');ctl('daemon-reload');install('--apply',false,'OFFICE_INSTALL_UNIT_OVERRIDE');await rm('/etc/systemd/system/'+unit+'.d',{recursive:true});ctl('daemon-reload');check('loaded override refused');
 install('--check');assert.equal(prop(unit,'ActiveState'),'inactive');assert.equal(prop(unit,'UnitFileState'),'disabled');assert.deepEqual(serverErrors,[]);
 console.log('SYSTEMD_INSTALL_PROOF='+JSON.stringify({schema:'qorpera.office-provider-installation-systemd-proof/v1',node:process.version,platform:process.platform,arch:process.arch,systemd:ok('/usr/bin/systemctl',['--version']).split('\n')[0],checks,packageManifestSha256:spec.packageManifestSha256,artifacts:JSON.parse(await readFile(root+'/package/manifest.json')).artifacts,journalFilesystem:'ext4',actualSystemd:true,actualKernelFlock:true,providerCapabilities:'zero',mixedCgroupStopMs:stopMs,registryRequests:requests.length,registryAuthority:'synthetic idle only',realNas:false,realKvm:false,deployed:false,modelCalls:false}));
}finally{
 exec('/usr/bin/systemctl',['stop',unit],95000);
 if(server){server.closeAllConnections();await new Promise(r=>server.close(()=>r()));}
 if(loop){exec('/usr/bin/umount',[mount]);exec('/usr/sbin/losetup',['--detach',loop]);}
}
