// Disposable Linux acceptance only. Uses the installed unit's six credential
// directives with a oneshot probe; no office admission or model work is started.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
export async function verifyOfficeBootCredentials(){
 const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim().replaceAll('-','');
 assert.match(boot,/^[0-9a-f]{32}$/);
 const parent='/etc/qorpera-office/boots',current=parent+'/'+boot,wrong=parent+'/'+(boot==='a'.repeat(32)?'b':'a').repeat(32);
 const probe='qorpera-office-boot-credentials-proof.service',script='/run/office-image-input/credential-probe.mjs',output='/run/office-boot-credentials-proof/result.json';
 const unit=await readFile('/etc/systemd/system/qorpera-company-computer.service','utf8');
 const lines=unit.split('\n').filter(line=>line.startsWith('LoadCredential='));assert.equal(lines.length,6);
 const files=lines.map(line=>{assert.match(line,/^LoadCredential=[a-z-]+:\/etc\/qorpera-office\/boots\/%b\/credentials\/[a-z.-]+$/);const [name,path]=line.slice('LoadCredential='.length).split(':');return{name,file:path.split('/').at(-1)};});
 const run=(...args)=>spawnSync('/usr/bin/systemctl',args,{encoding:'utf8',timeout:30000});
 const ok=(...args)=>{const r=run(...args);assert.equal(r.status,0,r.stdout+' '+r.stderr);return r.stdout.trim();};
 const expected={};
 try{
  await mkdir('/run/office-boot-credentials-proof',{mode:0o755});
  await writeFile(script,`import{readFileSync}from'node:fs';const names=${JSON.stringify(files.map(f=>f.name))};console.log(JSON.stringify(Object.fromEntries(names.map(n=>[n,readFileSync(process.env.CREDENTIALS_DIRECTORY+'/'+n,'utf8')]))));\n`,{mode:0o444});
  for(const directory of [current,wrong]){await mkdir(directory,{mode:0o755});await mkdir(directory+'/credentials',{mode:0o700});}
  for(const {name,file}of files){
   expected[name]='current synthetic '+name;
   await writeFile(current+'/credentials/'+file,expected[name],{mode:0o400});
   await writeFile(wrong+'/credentials/'+file,'wrong boot',{mode:0o400});
   await writeFile('/etc/qorpera-office/credentials/'+file,'original fallback',{mode:0o400});
  }
  await writeFile('/etc/systemd/system/'+probe,'[Service]\nType=oneshot\nUser=qorpera-office\nGroup=qorpera-office\n'+lines.join('\n')+'\nExecStart=/usr/bin/node '+script+'\nStandardOutput=file:'+output+'\n',{mode:0o644});
  ok('daemon-reload');
  ok('start',probe);assert.deepEqual(JSON.parse(await readFile(output,'utf8')),expected);
  // Keep both the original directory and another boot populated. No fallback
  // or missing-file repair may let this unit launch its main process.
  await rename(current,current+'-retained');await rm(output);
  assert.notEqual(run('start',probe).status,0);assert.equal(ok('show',probe,'--property=ExecMainStatus','--value'),'243');
  // systemd opens StandardOutput before credential setup, even when it refuses
  // exec with EXIT_CREDENTIALS. The probe must not have produced any output.
  assert.equal((await readFile(output)).length,0);
  await rename(current+'-retained',current);ok('reset-failed',probe);ok('start',probe);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),expected);
  return {actualBootId:boot,files:files.length,selectedCurrentBoot:true,wrongBootAndOriginalFallbackRefused:true,restoredExactBoot:true,actualSystemd:true};
 }finally{
  run('stop',probe);await rm('/etc/systemd/system/'+probe,{force:true});run('daemon-reload');
  for(const path of [current,current+'-retained',wrong,'/run/office-boot-credentials-proof',script])await rm(path,{recursive:true,force:true});
  for(const {file}of files)await rm('/etc/qorpera-office/credentials/'+file,{force:true});
  await chmod(parent,0o755);
 }
}
