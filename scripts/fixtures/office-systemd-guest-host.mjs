import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {SYSTEMD_CONTAINER_SECURITY,systemdContainerBoot} from './systemd-container.mjs';

/** Disposable actual-systemd guest. Files and commands cross a private docker
 * exec pipe; the provider still uses its real Unix HTTP transport and journals. */
export async function openOfficeSystemdGuest(repository,image,{retainedBoot=false}={}){
 assert(typeof image==='string'&&/^(?:[^\s]+@)?sha256:[0-9a-f]{64}$/.test(image),'Select digest-pinned QORPERA_OFFICE_SYSTEMD_TEST_IMAGE');
 // Package as a root build would: Ubuntu's default user umask 0002 leaves files group-writable,
 // and the installers refuse those as unprotected. Docker Desktop shows every mounted file as root 0644.
 process.umask(0o022);
 const temp=await mkdtemp(join(tmpdir(),'qorpera-office-sql-systemd-'));
 const command=(file,args)=>{const r=spawnSync(file,args,{cwd:repository,encoding:'utf8',timeout:120000,maxBuffer:4*1024**2});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 let container,child,lines;const pending=new Map();let sequence=0;const volume=basename(temp)+'-workbench';let volumeCreated=false;
 const close=async()=>{child?.stdin.end();child?.kill('SIGTERM');lines?.close();try{if(container)command('docker',['rm','-f',container]);}finally{try{if(volumeCreated)command('docker',['volume','rm',volume]);}finally{await rm(temp,{recursive:true,force:true});}}};
 try{
  const packaged=join(temp,'package');command(process.execPath,['scripts/package-company-computer.mjs','--out',packaged]);
  for(const [name,entry] of [['consumer','packages/runtime/test/fixtures/company-computer-service-stop-systemd-consumer.ts'],['image-consumer','packages/runner-orchestrator/test/fixtures/office-image-systemd-consumer.ts']])await build({absWorkingDir:repository,entryPoints:[entry],outfile:join(temp,name+'.mjs'),bundle:true,platform:'node',format:'esm',target:'node22.19',logLevel:'silent'});
  if(retainedBoot)await build({absWorkingDir:repository,entryPoints:['packages/runtime/src/cloud-identity-recovery-filesystems.ts'],outfile:join(temp,'mount.mjs'),bundle:true,platform:'node',format:'esm',target:'node22.19',logLevel:'silent'});
  const args=['run','-d','--name',basename(temp),'--pull','never','--network','none','--cgroupns','private','--cap-drop','ALL'];
  for(const cap of ['SYS_ADMIN','SYS_PTRACE','SYS_RESOURCE','SYS_CHROOT','CHOWN','DAC_OVERRIDE','FOWNER','FSETID','KILL','SETGID','SETUID','SETPCAP','AUDIT_WRITE'])args.push('--cap-add',cap);
  args.push(...SYSTEMD_CONTAINER_SECURITY,'--cpus','2','--memory','1g','--pids-limit','2048','--tmpfs','/run:rw,nosuid,nodev,size=192m,mode=755','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--tmpfs','/var/log/journal:rw,nosuid,nodev,size=16m,mode=755','--tmpfs','/etc/systemd/system:rw,nosuid,nodev,size=16m,mode=755','--env','container=docker');
  for(const [source,target] of [[packaged,'/fixture/package'],[join(temp,'consumer.mjs'),'/fixture/consumer.mjs'],[join(temp,'image-consumer.mjs'),'/fixture/image-consumer.mjs'],[resolve(repository,'scripts/fixtures/office-image-installation-systemd.mjs'),'/fixture/install-check.mjs'],[resolve(repository,`scripts/fixtures/${retainedBoot?'office-boot-sql-guest':'office-systemd-guest'}.mjs`),'/fixture/guest.mjs'],[resolve(repository,'scripts/fixtures/office-boot-credentials-systemd.mjs'),'/fixture/boot-credentials.mjs']])args.push('--mount',`type=bind,src=${source},dst=${target},readonly`);
  if(retainedBoot){command('docker',['volume','create',volume]);volumeCreated=true;args.push('--mount',`type=volume,source=${volume},target=/fixture/workbench`,'--mount',`type=bind,src=${join(temp,'mount.mjs')},dst=/fixture/mount.mjs,readonly`);}
  args.push(image,'/bin/bash','-c',systemdContainerBoot());container=command('docker',args);
  let ready=false;for(let i=0;i<40;i++){const poll=spawnSync('docker',['exec',container,'systemctl','show','--property=SystemState','--value'],{encoding:'utf8',timeout:10000});if(poll.status===0&&['running','degraded'].includes(poll.stdout.trim())){ready=true;break;}await delay(500);}assert(ready,'Disposable systemd guest did not become ready');
  child=spawn('docker',['exec','-i','-e','OFFICE_IMAGE_CONSUMER=/fixture/image-consumer.mjs',container,'node','/fixture/guest.mjs'],{stdio:['pipe','pipe','pipe']});
  let diagnostics='';child.stderr.on('data',bytes=>{diagnostics=(diagnostics+bytes.toString()).slice(-16000);});
  const receive=(id,resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Disposable guest response deadline'));},120000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});};
  const hello=new Promise((resolve,reject)=>receive(0,resolve,reject));
  const fail=error=>{for(const p of pending.values())p.reject(error);pending.clear();};
  child.once('error',fail);child.once('exit',(code)=>fail(new Error(`Disposable guest exited (${code}): ${diagnostics}`)));
  lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  lines.on('line',line=>{try{const value=JSON.parse(line),id=value.ready?0:value.id,p= pending.get(id);assert(p,'Unexpected guest reply');pending.delete(id);if(value.error)p.reject(new Error(value.error));else p.resolve(value.ready?value:value.result);}catch(error){fail(error);}});
  const initial=await hello;
  const call=(method,args={})=>new Promise((resolve,reject)=>{const id=++sequence;receive(id,resolve,reject);child.stdin.write(JSON.stringify({id,method,...args})+'\n');});
  return{bootId:initial.bootId,...(retainedBoot?{mount:initial.mount,uid:initial.uid,tlsCert:initial.tlsCert,tlsKey:initial.tlsKey,seed:files=>call('seed',{files:[...files].map(([path,file])=>({path,content:file.bytes.toString('base64'),mode:file.mode}))})}:{}),stage:async(path,content)=>{await call('stage',{path,content:content.toString('base64')});},execute:async argv=>{await call('execute',{argv});},read:async path=>{const value=await call('read',{path});return value?{...value,content:Buffer.from(value.content,'base64')}:undefined;},proof:()=>call('proof'),close};
 }catch(error){await close();throw error;}
}
